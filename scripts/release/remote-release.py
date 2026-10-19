#!/usr/bin/env python3
"""固定来源发布执行器；默认只读，演练限定于随机临时目录。"""
import base64
import fcntl
import hashlib
import io
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

REPOSITORY = "yihannangua/mindme"
JOBS = {"类型、格式、测试与构建", "浏览器与 Node 后端回归", "容器构建与备份恢复"}
FIXED = {"package.json", "package-lock.json", "LICENSE", "THIRD_PARTY_NOTICES.txt",
         "deploy/compose.yaml", "deploy/release.Dockerfile"}
REQUIRED = FIXED | {"dist/index.html", "dist-server/index.js", "dist-server/cli.js"}
SUMMARY = """
const {DatabaseSync}=require('node:sqlite');const {createHash}=require('node:crypto');
const d=new DatabaseSync(process.argv[1]||process.env.DATABASE_PATH,{readOnly:true});
const schema=d.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
const tables=schema.filter(x=>x.type==='table').map(x=>x.name);
const content=Object.fromEntries(tables.map(t=>[t,d.prepare('SELECT * FROM "'+t.replaceAll('"','""')+'"').all().map(x=>JSON.stringify(x)).sort()]));
const h=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const result={integrity:d.prepare('PRAGMA quick_check').get().quick_check,schema:h(schema),content:h(content),counts:Object.fromEntries(tables.map(t=>[t,content[t].length]))};
d.close();if(result.integrity!=='ok')process.exit(2);console.log(JSON.stringify(result));
"""


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def run(args, cwd=None):
    # 所有子进程输出均先捕获，失败时不把配置、令牌或数据库内容带进日志。
    result = subprocess.run(args, cwd=cwd, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE)
    require(result.returncode == 0, f"子进程执行失败：{args[0]}（退出码 {result.returncode}）")
    return result.stdout.strip()


def docker(*args):
    return run(["docker", *map(str, args)])


def safe_name(name):
    return isinstance(name, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{2,63}", name)


def safe_path(name):
    return (isinstance(name, str) and 0 < len(name) < 100
            and re.fullmatch(r"[A-Za-z0-9_./-]+", name)
            and all(x not in ("", ".", "..", ".git", ".env", "server.env", "node_modules", "data")
                    for x in name.split("/"))
            and not re.search(r"\.(sqlite.*|pem|key)$", name))


def verify_package(config, archive_path):
    require(archive_path.is_file() and not archive_path.is_symlink(), "发布包不是普通文件")
    require(archive_path.stat().st_size <= 32 * 1024 * 1024, "发布包超过大小限制")
    archive_data = archive_path.read_bytes()
    require(hashlib.sha256(archive_data).hexdigest() == config["packageSha256"], "发布包摘要不一致")
    files = {}
    with tarfile.open(fileobj=io.BytesIO(archive_data), mode="r:gz") as bundle:
        total = 0
        for member in bundle:
            name = member.name
            require(len(files) < 1000 and safe_path(name) and member.isfile()
                    and not member.pax_headers and name not in files, "归档路径、类型或重复成员非法")
            require(name in FIXED | {"release-source.json"} or name.startswith(("dist/", "dist-server/")),
                    "归档含非白名单文件")
            total += member.size
            require(0 <= member.size and total <= 64 * 1024 * 1024, "解压产物超过大小限制")
            files[name] = bundle.extractfile(member).read()
    require("release-source.json" in files and REQUIRED.issubset(files), "缺少必需发布产物")
    manifest = json.loads(files["release-source.json"])
    require(manifest.get("releaseProtocol") == 1 and manifest.get("repository") == REPOSITORY,
            "发布协议或仓库不符")
    require(manifest.get("sha") == config["sha"] and manifest.get("version") == config["version"],
            "发布源码或版本不符")
    ci = manifest.get("ci", {})
    require(str(ci.get("runId")) == str(config["ciRunId"]) and ci.get("headSha") == config["sha"], "CI 运行或 SHA 不符")
    require(ci.get("repository") == REPOSITORY and ci.get("headBranch") == "main"
            and ci.get("event") == "push" and ci.get("path") == ".github/workflows/ci.yml"
            and ci.get("status") == "completed" and ci.get("conclusion") == "success"
            and isinstance(ci.get("attempt"), int) and ci["attempt"] > 0, "CI 来源或完成状态不符")
    jobs = ci.get("jobs", [])
    require(isinstance(jobs, list) and all(isinstance(j, dict) and j.get("conclusion") == "success" for j in jobs)
            and JOBS.issubset({j.get("name") for j in jobs}), "缺少成功的必需 CI 作业")
    payload = set(files) - {"release-source.json"}
    require(payload == set(manifest.get("files", {})), "产物清单不一致")
    for name in payload:
        item = manifest["files"][name]
        require(len(files[name]) == item.get("bytes") and hashlib.sha256(files[name]).hexdigest() == item.get("sha256"),
                f"文件摘要不一致：{name}")
    package = json.loads(files["package.json"])
    lock = json.loads(files["package-lock.json"])
    require(package.get("version") == manifest["version"] == lock.get("version") == lock.get("packages", {}).get("", {}).get("version"),
            "产物版本不一致")
    require(hashlib.sha256(files["package-lock.json"]).hexdigest() == manifest.get("lockSha256"), "依赖锁摘要不符")
    return files, manifest


def compose_files(directory):
    for prefix in ("deploy", "deploy/tencent"):
        compose = directory / prefix / "compose.yaml"
        env = directory / prefix / ".env"
        if compose.is_file() and env.is_file():
            return compose, env
    raise RuntimeError("旧发布缺少 Compose 与部署元数据")


def compose(config, directory, *args):
    file, env = compose_files(directory)
    return docker("compose", "--project-name", config.get("projectName", "mindme"),
                  "--env-file", env, "-f", file, *args)


def validate_config(config):
    require(config.get("command") in ("deploy", "rollback") and config.get("mode") in ("plan", "apply"), "命令或模式非法")
    require(re.fullmatch(r"[a-f0-9]{40}", config.get("sha", "")), "必须提供完整源码 SHA")
    require(re.fullmatch(r"[a-f0-9]{64}", config.get("packageSha256", "")), "必须提供包 SHA-256")
    require(isinstance(config.get("container"), str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", config["container"]), "运行容器标识非法")
    require(isinstance(config.get("expectedImage"), str) and re.fullmatch(r"[A-Za-z0-9._:/@-]{1,255}", config["expectedImage"]), "预期镜像标识非法")
    for key in ("root", "serverEnv", "dataDir", "expectedCurrent"):
        require(isinstance(config.get(key), str) and re.fullmatch(r"/[A-Za-z0-9_./-]+", config[key]), f"路径非法：{key}")
    require(safe_name(config.get("release")) if config["command"] == "deploy" else safe_name(config.get("rollbackRelease")), "发布名称非法")
    root = pathlib.Path(config["root"]).resolve(strict=True)
    env = pathlib.Path(config["serverEnv"])
    data = pathlib.Path(config["dataDir"])
    require(not env.is_symlink() and env.is_file() and stat.S_IMODE(env.stat().st_mode) == 0o600, "私有配置必须是权限 0600 的普通文件")
    require(not data.is_symlink() and data.is_dir() and (data / "mindme.sqlite").is_file(), "持久数据目录或数据库不存在")
    releases = (root / "releases").resolve(strict=True)
    for path in (env.resolve(), data.resolve()):
        require(path != releases and releases not in path.parents, "配置和数据必须位于 releases 之外")
    if config.get("rehearsal"):
        sandbox = pathlib.Path(config.get("sandbox", "")).resolve(strict=True)
        require(sandbox.name.startswith("mindme-release-rehearsal-") and sandbox.parent == pathlib.Path(tempfile.gettempdir()).resolve(), "演练目录不是随机临时沙箱")
        require(all(sandbox in p.parents for p in (root, env.resolve(), data.resolve())), "演练路径逃出沙箱")
        require(config.get("projectName", "").startswith("mindme-release-ci-") and 10000 <= config.get("port", 0) <= 59999, "演练项目或端口非法")
    else:
        require(config.get("projectName", "mindme") == "mindme" and config.get("port", 3180) == 3180, "生产项目或端口不符")
    if config["mode"] == "apply":
        require(config.get("maintenance") == "confirmed", "未显式确认维护窗口")
    if config["command"] == "deploy" and config["mode"] == "apply":
        spool = pathlib.Path(config.get("spool", ""))
        if config.get("rehearsal"):
            sandbox = pathlib.Path(config["sandbox"]).resolve(strict=True)
            require(spool.resolve(strict=True).parent == sandbox and spool.is_dir(), "演练包路径超出沙箱")
        else:
            require(re.fullmatch(r"/tmp/mindme-release\.[A-Za-z0-9]+", str(spool)) and spool.is_dir(), "远程发布包必须位于随机临时目录")
        archive = spool / "release.tar.gz"
        require(archive.is_file() and not archive.is_symlink() and archive.stat().st_size <= 32 * 1024 * 1024, "远程发布包文件非法")
    return root, env.resolve(), data.resolve()


def inspect(config, root, data):
    require((root / "current").is_symlink(), "current 必须为符号链接")
    current = (root / "current").resolve(strict=True)
    require(str(current) == config["expectedCurrent"] and current.parent == (root / "releases").resolve(), "current 已变化或逃出 releases")
    info = json.loads(docker("inspect", config["container"]))[0]
    require(info["State"]["Running"], "旧应用未运行")
    require(info["Config"]["Image"] == config["expectedImage"], "旧镜像引用已变化")
    require(info["Config"].get("Labels", {}).get("com.docker.compose.project") == config.get("projectName", "mindme"), "Compose 项目不符")
    require(any(m["Destination"] == "/var/lib/mindme" and pathlib.Path(m["Source"]).resolve() == data and m.get("RW") for m in info["Mounts"]), "运行应用数据挂载不符")
    return current, info


def health(config, version):
    for _ in range(45):
        try:
            base = f"http://127.0.0.1:{config.get('port', 3180)}"
            with urllib.request.urlopen(base + "/api/health", timeout=3) as response:
                live = json.load(response)
            with urllib.request.urlopen(base + "/api/ready", timeout=3) as response:
                ready = json.load(response)
            if live.get("ok") is True and live.get("version") == version and ready.get("ready") is True:
                return {"health": live, "ready": ready}
        except Exception:
            pass
        time.sleep(2)
    raise RuntimeError("健康或就绪检查失败")


def snapshot(container, path="/var/lib/mindme/mindme.sqlite"):
    return json.loads(docker("exec", container, "node", "-e", SUMMARY, path))


def backup_and_compatibility(config, data, container, images, key):
    destination = data / "backups" / (key + ".sqlite")
    require(not destination.exists(), "备份名称已存在，拒绝覆盖")
    docker("exec", container, "node", "dist-server/cli.js", "backup", "/var/lib/mindme/backups/" + destination.name)
    require(destination.is_file() and stat.S_IMODE(destination.stat().st_mode) == 0o600 and destination.stat().st_size >= 4096, "备份文件权限或大小不符")
    before = snapshot(container, "/var/lib/mindme/backups/" + destination.name)
    with tempfile.TemporaryDirectory(prefix="mindme-restore-") as directory:
        restored = pathlib.Path(directory) / "mindme.sqlite"
        shutil.copyfile(destination, restored)
        os.chown(directory, 1000, 1000)
        os.chown(restored, 1000, 1000)
        restored.chmod(0o600)
        args = ["run", "--rm", "--network", "none", "--read-only", "--tmpfs", "/tmp", "--user", "1000:1000",
                "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "-v", directory + ":/var/lib/mindme",
                "-e", "DATABASE_PATH=/var/lib/mindme/mindme.sqlite", "--entrypoint", "node"]
        for image in images:
            docker(*args, image, "dist-server/cli.js", "inspect")
            after = json.loads(docker(*args, image, "-e", SUMMARY))
            require(after == before, "备份恢复或新旧应用兼容性核验失败：结构或内容发生变化")
    return {"path": str(destination), "mode": "600", "size": destination.stat().st_size,
            "sha256": hashlib.sha256(destination.read_bytes()).hexdigest(), "quickCheck": before["integrity"],
            "restored": True, "compatible": True, "schema": before["schema"]}


def atomic_current(root, target):
    temp = root / (".current-" + str(os.getpid()))
    temp.symlink_to(target)
    os.replace(temp, root / "current")


def apply(config, root, env, data):
    current, old = inspect(config, root, data)
    old_version = json.loads((current / "package.json").read_text())["version"]
    if config["command"] == "deploy":
        target = root / "releases" / config["release"]
        require(not target.exists(), "新发布目录已存在")
        files, manifest = verify_package(config, pathlib.Path(config["spool"]) / "release.tar.gz")
        require(not manifest.get("rehearsalOnly") or config.get("rehearsal"), "演练包不能用于生产发布")
        target.mkdir(mode=0o700)
        for name, value in files.items():
            path = target / name
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("xb") as output:
                output.write(value)
        image = "mindme:" + config["release"]
        build_args = {"SOURCE_SHA": config["sha"], "SOURCE_CI_RUN": str(config["ciRunId"]),
                      "SOURCE_PACKAGE_SHA256": config["packageSha256"], "APP_VERSION": config["version"],
                      "NODE_IMAGE": config["nodeImage"]}
        command = ["build", "--pull", "-t", image, "-f", str(target / "deploy/release.Dockerfile")]
        for name, value in build_args.items():
            command.extend(["--build-arg", name + "=" + value])
        docker(*command, target)
        image_info = json.loads(docker("image", "inspect", image))[0]
        labels = image_info["Config"].get("Labels", {})
        expected_labels = {"org.opencontainers.image.source": "https://github.com/" + REPOSITORY,
                           "org.opencontainers.image.revision": config["sha"], "org.opencontainers.image.version": config["version"],
                           "com.mindme.ci.run": str(config["ciRunId"]), "com.mindme.package.sha256": config["packageSha256"]}
        require(all(labels.get(k) == v for k, v in expected_labels.items()), "镜像来源标签不符")
        version = config["version"]
        metadata = {"MINDME_RELEASE": config["release"], "MINDME_PORT": str(config.get("port", 3180)),
                    "MINDME_DATA_DIR": str(data), "MINDME_SERVER_ENV": str(env)}
        (target / "deploy/.env").write_text("".join(k + "=" + v + "\n" for k, v in metadata.items()))
        (target / "deploy/.env").chmod(0o600)
    else:
        target = (root / "releases" / config["rollbackRelease"]).resolve(strict=True)
        require(target.parent == (root / "releases").resolve() and target != current, "回滚目标非法")
        version = json.loads((target / "package.json").read_text())["version"]
        parsed = json.loads(compose(config, target, "config", "--format", "json"))
        service = parsed["services"]["mindme"]
        require(any(v["target"] == "/var/lib/mindme" and pathlib.Path(v.get("source", "")).resolve() == data for v in service["volumes"]), "回滚会切换持久数据目录，拒绝执行")
        image_info = json.loads(docker("image", "inspect", service["image"]))[0]
    backup = backup_and_compatibility(config, data, config["container"], [image_info["Id"], old["Image"]],
                                      "before-" + config["command"] + "-" + str(time.time_ns()))
    # 构建期间可能发生其他操作；切换前再次核对实际旧容器。
    inspect(config, root, data)
    try:
        compose(config, target, "up", "-d", "--no-build", "--wait", "--wait-timeout", "90")
        results = health(config, version)
        live_id = compose(config, target, "ps", "-q", "mindme")
        live = json.loads(docker("inspect", live_id))[0]
        require(live["Image"] == image_info["Id"], "运行镜像与已验证摘要不符")
        require(snapshot(live_id)["schema"] == backup["schema"], "应用改变数据结构，停止自动回滚")
        atomic_current(root, target)
    except Exception:
        ids = compose(config, target, "ps", "-q", "mindme")
        require(ids and snapshot(ids)["schema"] == backup["schema"], "数据结构或实例状态不明，停止自动回滚并保全数据")
        compose(config, current, "up", "-d", "--no-build", "--wait", "--wait-timeout", "90")
        health(config, old_version)
        atomic_current(root, current)
        raise
    record = {"sourceSha": config["sha"], "ciRun": config["ciRunId"], "packageSha256": config["packageSha256"],
              "imageId": image_info["Id"], "previousRelease": str(current), "backup": backup, **results,
              "databaseRestored": False, "command": config["command"]}
    record_path = target / ("deployment-record.json" if config["command"] == "deploy" else "rollback-record.json")
    record_path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n")
    record_path.chmod(0o600)
    print(json.dumps({"command": config["command"], "sha": config["sha"], "imageId": image_info["Id"],
                      "backupRestored": True, "databaseRestored": False}, ensure_ascii=False))


def main(config):
    root, env, data = validate_config(config)
    if config["mode"] == "plan":
        current, info = inspect(config, root, data)
        require(snapshot(config["container"])["integrity"] == "ok", "数据库完整性检查失败")
        print(json.dumps({"mode": "plan", "imageId": info["Image"], "envMode": "600", "current": str(current)}))
        return
    with (root / ".release.lock").open("a") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("另一发布进程正在执行")
        apply(config, root, env, data)


if __name__ == "__main__":
    try:
        require(len(sys.argv) == 2, "缺少发布参数")
        main(json.loads(base64.b64decode(sys.argv[1], validate=True)))
    except Exception as error:
        print("发布停止：" + (str(error) if isinstance(error, RuntimeError) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
