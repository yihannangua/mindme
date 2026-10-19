// 使用真实 ZIP 字节和 XML DOM 验证解析及整批提交；不替代 XMind 实机/浏览器验收。
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const fflate = require("fflate");
const { DOMParser } = require("@xmldom/xmldom");

class StrictDOMParser {
  parseFromString(text, type) {
    return new DOMParser({ onError: (_level, message) => { throw new Error(message); } }).parseFromString(text, type);
  }
}
function fixture() {
  class FakeElement {
    constructor() { this.hidden = true; this.value = ""; this.disabled = false; }
    closest() { return null; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    setAttribute() {}
    addEventListener() {}
    focus() {}
  }
  const elements = new Map(), listeners = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new FakeElement());
    return elements.get(id);
  };
  const context = vm.createContext({
    console, Element: FakeElement, TextDecoder, DOMParser: StrictDOMParser,
    setTimeout: () => 1, clearTimeout: () => {},
    document: { activeElement: null, getElementById: element, querySelectorAll: () => [], addEventListener: (name, fn) => listeners.set(name, fn) },
  });
  for (const file of ["fflate.min.js", "importer.js", "editor.js"]) {
    const source = fs.readFileSync(path.join(__dirname, file), "utf8").replace(/render\(\);\s*updateSync\(\);\s*$/, "");
    vm.runInContext(source, context);
  }
  vm.runInContext("render=()=>{};updateSync=()=>{};", context);
  return {
    context,
    run: (source) => vm.runInContext(source, context),
    state: (source) => JSON.parse(vm.runInContext(`JSON.stringify(${source})`, context)),
    importer: context.MindmeImport,
    element,
    snapshot() { return this.state("({maps,trash,current,selected,serial,pending,undoStack,redoStack,panX,panY,zoom})"); },
  };
}
const topic = (id, title, body = "") => `<topic id="${id}"><title>${title}</title>${body}</topic>`;
const sheet = (root) => `<sheet>${root}</sheet>`;
const xml = (...sheets) => `<?xml version="1.0" encoding="UTF-8"?><xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0">${sheets.join("")}</xmap-content>`;
const refs = (...ids) => `<marker-refs>${ids.map((id) => `<marker-ref marker-id="${id}"/>`).join("")}</marker-refs>`;
const children = (...topics) => `<children><topics type="attached">${topics.join("")}</topics></children>`;
function asFile(bytes, name = "示例.xmind") {
  return { name, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}
const archive = (text, level = 6) => fflate.zipSync({ "content.xml": fflate.strToU8(text), "attachments/ignore.bin": new Uint8Array([0, 1, 2]) }, { level });
const plain = (value) => JSON.parse(JSON.stringify(value));
const valid = xml(sheet(topic("root-source", "真实脑图", children(topic("child", "子主题", refs("flag-blue"))))));

test("读取真实 ZIP/XML 的多张脑图，保留文字、层级及常用标记，未知标记单独报告", async () => {
  const app = fixture();
  const text = xml(
    sheet(topic("r", "发布 &amp; 验证", children(topic("c", "子主题", refs("priority-2", "task-3oct", "flag-blue", "custom-unknown"))))),
    sheet(topic("r", "第二张脑图")),
  );
  for (const level of [0, 6]) {
    const result = await app.importer.parseXmindFile(asFile(archive(text, level)));
    assert.equal(result.drafts.length, 2);
    assert.equal(result.drafts[0].nodes[0].text, "发布 & 验证");
    assert.equal(result.drafts[0].nodes[1].parent, "root");
    assert.deepEqual(plain(result.drafts[0].nodes[1].markers), { priority: "②", progress: "3/8", flag: "blue" });
    assert.deepEqual(plain(result.ignored), ["custom-unknown"]);
    app.importer.validateDrafts(result.drafts);
  }
});

test("XML 命名空间前缀、空中心主题及空子主题保留，所有子主题组均导入", () => {
  const app = fixture();
  const text = '<x:xmap-content xmlns:x="urn:xmind:xmap:xmlns:content:2.0"><x:sheet><x:topic id="r"><x:title> </x:title><x:children><x:topics type="detached"><x:topic id="c"><x:title/></x:topic></x:topics></x:children></x:topic></x:sheet></x:xmap-content>';
  const result = app.importer.parseXmindContent(text);
  assert.equal(result.drafts[0].nodes[0].text, "未命名脑图");
  assert.equal(result.drafts[0].nodes[1].text, "");
  assert.equal(result.warnings.length, 1);
});

test("不支持的优先级不擅自映射为其他优先级，同类冲突明确报告", () => {
  const app = fixture();
  const result = app.importer.parseXmindContent(xml(sheet(topic("r", "标记", refs("priority-9", "task-done", "task-start", "flag-yellow")))));
  assert.deepEqual(plain(result.ignored), ["priority-9"]);
  assert.deepEqual(plain(result.drafts[0].nodes[0].markers), { progress: "start", flag: "orange" });
  assert.equal(result.warnings.length, 1);
});

test("非 ZIP、截断、校验错误与新格式文件拒绝导入并说明原因", async () => {
  const app = fixture();
  await assert.rejects(app.importer.parseXmindFile(asFile(new Uint8Array(30))), /目录/);
  const bytes = archive(valid, 0);
  await assert.rejects(app.importer.parseXmindFile(asFile(bytes.slice(0, -5))), /目录/);
  const damaged = bytes.slice(), textStart = 30 + new DataView(damaged.buffer).getUint16(26, true) + new DataView(damaged.buffer).getUint16(28, true);
  damaged[textStart + 5] ^= 1;
  await assert.rejects(app.importer.parseXmindFile(asFile(damaged)), /校验失败/);
  const modern = fflate.zipSync({ "content.json": fflate.strToU8("[]") });
  await assert.rejects(app.importer.parseXmindFile(asFile(modern)), /新版 XMind/);
});

test("缺少内容、重复内容条目、错误目录以及不支持的压缩方式均失败", async () => {
  const app = fixture();
  await assert.rejects(app.importer.parseXmindFile(asFile(fflate.zipSync({ "other.xml": new Uint8Array() }))), /缺少 content.xml/);
  const duplicate = fflate.zipSync({ "content.xml": fflate.strToU8(valid), "content.xm2": fflate.strToU8(valid) });
  const oldName = Buffer.from("content.xm2"), replacement = Buffer.from("content.xml");
  for (let index = 0; index < duplicate.length - oldName.length; index++) {
    if (oldName.every((byte, position) => duplicate[index + position] === byte)) duplicate.set(replacement, index);
  }
  await assert.rejects(app.importer.parseXmindFile(asFile(duplicate)), /重复的 content.xml/);
  const method = archive(valid).slice(), view = new DataView(method.buffer);
  let central = -1;
  for (let i = 0; i < method.length - 4; i++) if (view.getUint32(i, true) === 0x02014b50) { central = i; break; }
  view.setUint16(central + 10, 99, true);
  await assert.rejects(app.importer.parseXmindFile(asFile(method)), /不支持的压缩/);
  const broken = archive(valid).slice(), brokenView = new DataView(broken.buffer);
  brokenView.setUint32(broken.length - 22 + 16, 0xffffff00, true);
  await assert.rejects(app.importer.parseXmindFile(asFile(broken)), /目录损坏/);
});

test("格式错误、实体声明、重复节点或任一脑图缺根时整批拒绝", () => {
  const app = fixture();
  assert.throws(() => app.importer.parseXmindContent("<xmap-content><sheet></xmap-content>"), /格式损坏/);
  assert.throws(() => app.importer.parseXmindContent('<!DOCTYPE xmap-content [<!ENTITY test "x">]><xmap-content/>'), /实体声明/);
  assert.throws(() => app.importer.parseXmindContent(xml(sheet(topic("same", "根", children(topic("same", "子")))))), /重复/);
  assert.throws(() => app.importer.parseXmindContent(xml(sheet(topic("r", "正常")), "<sheet/>")), /中心主题/);
  assert.throws(() => app.importer.parseXmindContent(xml()), /没有可导入/);
  assert.throws(() => app.importer.parseXmindContent(xml(sheet(topic("r", "根", topic("stray", "错误位置的子主题"))))), /无法识别的主题层级/);
});

test("文件读失败、扩展名、空文件和体积限制给出明确错误", async () => {
  const app = fixture();
  await assert.rejects(app.importer.parseXmindFile(asFile(new Uint8Array())), /文件为空/);
  await assert.rejects(app.importer.parseXmindFile(asFile(archive(valid), "wrong.txt")), /扩展名/);
  await assert.rejects(app.importer.parseXmindFile({ name: "large.xmind", size: app.importer.limits.fileBytes + 1, arrayBuffer: async () => { throw Error("不应读取"); } }), /20 MB/);
  await assert.rejects(app.importer.parseXmindFile({ name: "fail.xmind", size: 1, arrayBuffer: async () => { throw Error("读失败"); } }), /无法读取/);
});

test("节点数、深度和 ZIP 声明的解压量在写入前受限", async () => {
  const app = fixture();
  assert.throws(() => app.importer.parseOutline("- 节点\n".repeat(5001)), /5000/);
  assert.throws(() => app.importer.parseOutline(" ".repeat(258) + "- 太深"), /128/);
  let nested = topic("end", "末尾");
  for (let i = 0; i < 130; i++) nested = topic("t" + i, "嵌套", children(nested));
  assert.throws(() => app.importer.parseXmindContent(xml(sheet(nested))), /128/);
  const bytes = archive(valid).slice(), view = new DataView(bytes.buffer);
  for (let i = 0; i < bytes.length - 46; i++) if (view.getUint32(i, true) === 0x02014b50) { view.setUint32(i + 24, app.importer.limits.xmlBytes + 1, true); break; }
  await assert.rejects(app.importer.parseXmindFile(asFile(bytes)), /过大/);
});

test("同批重名与回收站名称占用自动编号，中心主题和标签联动，重复导入不覆盖", () => {
  const app = fixture(), before = app.state("maps");
  const drafts = app.importer.parseXmindContent(xml(sheet(topic("r", "上周的计划")), sheet(topic("r", "上周的计划")))).drafts;
  app.context.drafts = drafts;
  app.run("commitImportedMaps(drafts);commitImportedMaps(drafts)");
  const imported = app.state("maps.slice(-4)");
  assert.deepEqual(imported.map((item) => item.title), ["上周的计划（2）", "上周的计划（3）", "上周的计划（4）", "上周的计划（5）"]);
  assert.deepEqual(app.state("maps.slice(0,3)"), before);
  for (const item of imported) { assert.ok(item.open); assert.equal(item.nodes[0].text, item.title); }
  assert.equal(app.state("selected"), "root");
});

test("后续脑图损坏、孤立节点或循环时，任何新标签和历史都不写入", () => {
  const app = fixture(), before = app.snapshot();
  app.context.drafts = [{ nodes: [{ id: "root", parent: null, text: "正常", markers: {} }] }, { nodes: [{ id: "bad", parent: "missing", text: "损坏", markers: {} }] }];
  assert.throws(() => app.run("commitImportedMaps(drafts)"), /引用/);
  assert.deepEqual(app.snapshot(), before);
  app.context.drafts[1].nodes[0].parent = "bad";
  assert.throws(() => app.run("commitImportedMaps(drafts)"), /引用/);
  assert.deepEqual(app.snapshot(), before);
});

test("提交渲染出错时还原脑图、标签、名称编号、视角、待同步状态与撤销栈", () => {
  const app = fixture();
  app.run("selected='a';panX=23;zoom=1.2;pending=2");
  const before = app.snapshot();
  app.context.drafts = app.importer.parseXmindContent(valid).drafts;
  app.run("render=()=>{throw new Error('注入渲染失败')}");
  assert.throws(() => app.run("commitImportedMaps(drafts)"), /注入渲染失败/);
  assert.deepEqual(app.snapshot(), before);
  app.run("pasteOutline('# 根\\n- 子节点')");
  assert.deepEqual(app.snapshot(), before);
});

test("空 Markdown 不写模型，超过节点限制失败时也不创建历史", () => {
  const app = fixture(), before = app.snapshot();
  app.run("pasteOutline('   \\n\\n')");
  assert.deepEqual(app.snapshot(), before);
  assert.match(app.element("toast").textContent, /没有可导入内容/);
  app.run("pasteOutline('- 节点\\n'.repeat(5001))");
  assert.deepEqual(app.snapshot(), before);
});

test("较长大纲新建后继续粘贴，节点标识保持唯一，撤销只恢复本次追加", () => {
  const app = fixture();
  app.run("selected=null;pasteOutline('# 大纲\\n'+'- 子主题\\n'.repeat(40));pasteOutline('- 后续节点')");
  const ids = app.state("map().nodes.map(node=>node.id)");
  assert.equal(new Set(ids).size, 42);
  app.run("undo()");
  assert.equal(app.state("map().nodes.length"), 41);
});

test("真实导入失败保留输入与模型，错误原因在导入窗口持续可见", async () => {
  const app = fixture();
  app.run("dialog('import')");
  app.element("paste-text").value = "用户草稿";
  const before = app.snapshot();
  app.context.file = asFile(new Uint8Array(30));
  await app.run("importXmindFile(file)");
  assert.deepEqual(app.snapshot(), before);
  assert.equal(app.element("paste-text").value, "用户草稿");
  assert.equal(app.element("import-feedback").hidden, false);
  assert.match(app.element("import-feedback").textContent, /导入失败.*目录/);
  assert.equal(app.element("pick-xmind").disabled, false);
});

test("文件读取中关闭或重开窗口，迟到的解析结果不会写入或覆盖新窗口", async () => {
  const app = fixture(), bytes = archive(valid);
  let release;
  app.context.file = { name: "slow.xmind", size: bytes.length, arrayBuffer: () => new Promise((resolve) => { release = resolve; }) };
  app.run("dialog('import')");
  const before = app.snapshot(), pending = app.run("importXmindFile(file)");
  app.run("close();dialog('import')");
  release(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  await pending;
  assert.deepEqual(app.snapshot(), before);
  assert.equal(app.state("dialogKind"), "import");
});

test("未知标记完成报告列出具体名称并转义，确认后可关闭", async () => {
  const app = fixture();
  app.context.file = asFile(archive(xml(sheet(topic("r", "主题", refs("custom-&lt;unsafe&gt;"))))));
  app.run("dialog('import')");
  await app.run("importXmindFile(file)");
  assert.equal(app.state("maps.length"), 4);
  assert.equal(app.state("dialogKind"), "import-result");
  assert.match(app.element("dialog-body").innerHTML, /custom-&lt;unsafe&gt;/);
  assert.ok(!app.element("dialog-body").innerHTML.includes("custom-<unsafe>"));
  app.element("import-result-close").onclick();
  assert.equal(app.state("dialogKind"), "");
});
