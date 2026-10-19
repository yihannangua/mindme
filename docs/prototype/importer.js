"use strict";
// 独立解析层只返回草稿；不得修改编辑器数据或打开标签。
(function (root) {
  const limits = Object.freeze({ fileBytes: 20 * 1024 * 1024, xmlBytes: 16 * 1024 * 1024, nodes: 5000, depth: 128 });
  const elements = (parent) => Array.from(parent?.childNodes || []).filter((child) => child.nodeType === 1);
  const named = (node, name) => node?.localName === name || node?.nodeName === name;
  const direct = (parent, name) => elements(parent).filter((child) => named(child, name));
  const child = (parent, name) => direct(parent, name)[0];
  const fail = (message) => { throw new Error(message); };

  function parseOutline(text) {
    if (typeof text !== "string") fail("大纲内容必须是文字");
    if (text.length > limits.xmlBytes) fail("大纲过大，请拆分后导入");
    const nodes = [], stack = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const heading = line.match(/^(#{1,6})\s+(.*)$/), list = line.match(/^(\s*)[-*+]\s+(.*)$/);
      const indent = (line.match(/^\s*/)?.[0] || "").replace(/\t/g, "  ").length;
      const depth = heading ? heading[1].length - 1 : list ? 1 + Math.floor(list[1].replace(/\t/g, "  ").length / 2) : Math.floor(indent / 2);
      const label = (heading ? heading[2] : list ? list[2] : line.trim()).trim();
      if (!label) continue;
      if (depth > limits.depth) fail("大纲层级过深，本次最多支持 128 层");
      if (nodes.length >= limits.nodes) fail("内容过多，本次最多支持 5000 个节点");
      while (stack.length && stack.at(-1).depth >= depth) stack.pop();
      const item = { id: "outline" + nodes.length, parent: stack.at(-1)?.id || null, text: label, markers: {} };
      nodes.push(item);
      stack.push({ depth, id: item.id });
    }
    return nodes;
  }

  // 只映射当前目录中确实存在的图标，不能把无法识别的值强行改成其他标记。
  function markerFromXmind(id, ignored) {
    const known = {
      "priority-1": ["priority", "①"], "priority-2": ["priority", "②"],
      "priority-3": ["priority", "③"], "priority-4": ["priority", "④"],
      "task-start": ["progress", "start"], "task-oct": ["progress", "1/8"],
      "task-quarter": ["progress", "2/8"], "task-3oct": ["progress", "3/8"],
      "task-half": ["progress", "4/8"], "task-5oct": ["progress", "5/8"],
      "task-3quar": ["progress", "6/8"], "task-7oct": ["progress", "7/8"],
      "task-done": ["progress", "done"],
    };
    for (const color of ["red", "orange", "blue", "green", "purple", "teal", "gray"])
      known["flag-" + color] = ["flag", color];
    // XMind 8 的黄色旗子使用面板中对应的橙黄色。
    known["flag-yellow"] = ["flag", "orange"];
    if (Object.hasOwn(known, id)) return known[id];
    ignored.add(id || "未命名标记");
    return null;
  }

  function parseXmindContent(xml) {
    if (typeof xml !== "string" || !xml.trim()) fail("XMind 内容为空，没有可导入内容");
    if (xml.length > limits.xmlBytes) fail("XMind 内容过大，请拆分后导入");
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) fail("XMind 内容包含不支持的 XML 文档类型或实体声明");
    if (!root.DOMParser) fail("当前环境无法解析 XMind 内容");
    let doc;
    try { doc = new root.DOMParser().parseFromString(xml, "application/xml"); }
    catch { fail("content.xml 格式损坏"); }
    if (!doc?.documentElement || doc.getElementsByTagName("parsererror").length || doc.getElementsByTagNameNS?.("*", "parsererror").length)
      fail("content.xml 格式损坏");
    if (!named(doc.documentElement, "xmap-content")) fail("无法识别 XMind 8 内容结构");
    const sheets = direct(doc.documentElement, "sheet"), drafts = [], ignored = new Set(), warnings = new Set();
    let count = 0;
    if (!sheets.length) fail("XMind 文件没有可导入的脑图");
    for (const sheet of sheets) {
      const roots = direct(sheet, "topic"), nodes = [], seen = new Set();
      if (roots.length !== 1) fail("XMind 脑图缺少唯一的中心主题");
      function visit(topic, parent, depth) {
        if (depth > limits.depth) fail("XMind 层级过深，本次最多支持 128 层");
        if (++count > limits.nodes) fail("内容过多，本次最多支持 5000 个节点");
        const sourceId = topic.getAttribute("id");
        if (sourceId && seen.has(sourceId)) fail("XMind 文件存在重复的节点标识");
        if (sourceId) seen.add(sourceId);
        const id = parent === null ? "root" : "xmind-" + nodes.length;
        const title = child(topic, "title")?.textContent || "";
        const item = { id, parent, text: parent === null ? title.trim() || "未命名脑图" : title, markers: {} };
        for (const markerGroup of ["markers", "marker-refs"]) for (const ref of direct(child(topic, markerGroup), "marker-ref")) {
          const markerId = ref.getAttribute("marker-id"), marker = markerFromXmind(markerId, ignored);
          if (!marker) continue;
          if (item.markers[marker[0]] && item.markers[marker[0]] !== marker[1])
            warnings.add(`主题「${item.text || "空主题"}」有多个同类标记，仅保留最后一个`);
          item.markers[marker[0]] = marker[1];
        }
        nodes.push(item);
        // 文字、层级保留；自由主题纳入同一父主题，位置交由编辑器布局。
        for (const group of direct(child(topic, "children"), "topics")) {
          if (group.getAttribute("type") && group.getAttribute("type") !== "attached")
            warnings.add("自由主题或概要主题按原父主题层级导入，位置由自动布局生成");
          for (const nested of direct(group, "topic")) visit(nested, id, depth + 1);
        }
      }
      visit(roots[0], null, 0);
      drafts.push({ title: nodes[0].text, nodes });
    }
    const topicCount = doc.getElementsByTagNameNS("*", "topic").length;
    if (topicCount !== count) fail("XMind 存在无法识别的主题层级，未导入任何脑图");
    return { drafts, ignored: [...ignored], warnings: [...warnings] };
  }

  const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  function crc32(bytes) {
    let value = 0xffffffff;
    for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
  }

  // 先检查 ZIP 目录，只解压内容文件，不展开附件；核对长度与 CRC，避免接受损坏内容。
  function extractContent(bytes) {
    if (bytes.length < 22) fail("文件损坏，无法读取 XMind 压缩包");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = bytes.length - 22;
    for (; end >= Math.max(0, bytes.length - 65557); end--)
      if (view.getUint32(end, true) === 0x06054b50 && end + 22 + view.getUint16(end + 20, true) === bytes.length) break;
    if (end < Math.max(0, bytes.length - 65557)) fail("文件损坏，无法读取 XMind 压缩包目录");
    const count = view.getUint16(end + 10, true), directory = view.getUint32(end + 16, true), directorySize = view.getUint32(end + 12, true);
    if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count)
      fail("暂不支持分卷 XMind 文件");
    if (count === 65535 || directory === 0xffffffff || directorySize === 0xffffffff) fail("暂不支持 ZIP64 XMind 文件");
    if (directory + directorySize > end) fail("XMind 压缩包目录损坏");
    let offset = directory, content = null, modern = false;
    for (let i = 0; i < count; i++) {
      if (offset + 46 > directory + directorySize || view.getUint32(offset, true) !== 0x02014b50) fail("XMind 压缩包目录损坏");
      const nameLength = view.getUint16(offset + 28, true), extraLength = view.getUint16(offset + 30, true), commentLength = view.getUint16(offset + 32, true);
      const next = offset + 46 + nameLength + extraLength + commentLength;
      if (next > directory + directorySize) fail("XMind 压缩包目录损坏");
      const name = new root.TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
      if (name === "content.json") modern = true;
      if (name === "content.xml") {
        if (content) fail("XMind 文件包含重复的 content.xml");
        const compressed = view.getUint32(offset + 20, true), original = view.getUint32(offset + 24, true), local = view.getUint32(offset + 42, true), method = view.getUint16(offset + 10, true);
        if (view.getUint16(offset + 8, true) & 1) fail("暂不支持加密的 XMind 文件");
        if (original > limits.xmlBytes || compressed > limits.fileBytes) fail("XMind 内容过大，请拆分后导入");
        if (method !== 0 && method !== 8) fail("XMind 使用了不支持的压缩方式");
        if (local + 30 > directory || view.getUint32(local, true) !== 0x04034b50) fail("XMind 内容文件头损坏");
        const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
        if (start + compressed > directory || view.getUint16(local + 8, true) !== method || (view.getUint16(local + 6, true) & 1)) fail("XMind 内容文件数据损坏");
        const localName = new root.TextDecoder().decode(bytes.subarray(local + 30, local + 30 + view.getUint16(local + 26, true)));
        if (localName !== name) fail("XMind 内容文件名与目录不一致");
        content = { original, crc: view.getUint32(offset + 16, true) };
      }
      offset = next;
    }
    if (offset !== directory + directorySize) fail("XMind 压缩包目录损坏");
    if (!content) fail(modern ? "这是新版 XMind 格式，目前支持 XMind 8 的 content.xml 格式" : "文件缺少 content.xml，无法识别为 XMind 8 文件");
    if (!root.fflate?.unzipSync) fail("XMind 解压模块未加载，请刷新页面重试");
    let xml;
    try { xml = root.fflate.unzipSync(bytes, { filter: (entry) => entry.name === "content.xml" })["content.xml"]; }
    catch { fail("XMind 压缩内容损坏，解压失败"); }
    if (!xml || xml.length !== content.original || crc32(xml) !== content.crc) fail("XMind 内容校验失败，文件可能已损坏");
    try { return new root.TextDecoder("utf-8", { fatal: true }).decode(xml); }
    catch { fail("XMind 内容不是有效的 UTF-8 文字"); }
  }

  async function parseXmindFile(file) {
    if (!file || typeof file.arrayBuffer !== "function") fail("请选择 XMind 文件");
    if (!/\.xmind$/i.test(file.name || "")) fail("请选择扩展名为 .xmind 的文件");
    if (!file.size) fail("文件为空，没有可导入内容");
    if (file.size > limits.fileBytes) fail("文件过大，本次最多支持 20 MB");
    let bytes;
    try { bytes = new Uint8Array(await file.arrayBuffer()); }
    catch { fail("无法读取文件，请重新选择"); }
    if (bytes.length > limits.fileBytes) fail("文件过大，本次最多支持 20 MB");
    return parseXmindContent(extractContent(bytes));
  }

  function validateDrafts(drafts) {
    if (!Array.isArray(drafts) || !drafts.length) fail("没有可导入内容");
    let total = 0;
    for (const draft of drafts) {
      if (!Array.isArray(draft.nodes) || !draft.nodes.length) fail("导入脑图缺少节点");
      if ((total += draft.nodes.length) > limits.nodes) fail("内容过多，本次最多支持 5000 个节点");
      const seen = new Map();
      let roots = 0;
      // 解析层按父先子后输出；此处拒绝孤立节点、重复标识及循环，写入前完成全批检查。
      for (const node of draft.nodes) {
        if (typeof node.id !== "string" || !node.id || seen.has(node.id) || typeof node.text !== "string") fail("导入节点结构损坏");
        const depth = node.parent === null ? 0 : seen.has(node.parent) ? seen.get(node.parent) + 1 : -1;
        if (depth < 0 || depth > limits.depth) fail("导入节点引用或层级无效");
        if (node.parent === null) roots++;
        if (!node.markers || Array.isArray(node.markers) || typeof node.markers !== "object" || Object.values(node.markers).some((value) => typeof value !== "string")) fail("导入标记结构损坏");
        seen.set(node.id, depth);
      }
      if (roots !== 1) fail("导入脑图必须有唯一的中心主题");
    }
  }

  root.MindmeImport = Object.freeze({ limits, parseOutline, parseXmindContent, parseXmindFile, validateDrafts });
})(globalThis);
