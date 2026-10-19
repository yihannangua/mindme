"use strict";
// 本文件仅为内存中的交互草图，不连接账号、数据库或云同步服务。
const $ = (id) => document.getElementById(id),
  esc = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (ch) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[ch],
    );
const clone = (value) => JSON.parse(JSON.stringify(value));
// 图标按用户提供的参考图绘制，存储稳定标识，面板与节点共用同一套图形。
const markerGroups = [
  { category: "priority", label: "优先级", values: ["①", "②", "③", "④"] },
  { category: "progress", label: "任务进度", values: ["start", "1/8", "2/8", "3/8", "4/8", "5/8", "6/8", "7/8", "done"] },
  { category: "flag", label: "旗子", values: ["red", "orange", "blue", "green", "purple", "teal", "gray"] },
];
const flagColors = { red: "#ff4d4f", orange: "#ffb400", blue: "#4c8dff", green: "#00cc55", purple: "#c448d5", teal: "#20afa7", gray: "#737fa3" };
const flagLabels = { red: "红色", orange: "橙色", blue: "蓝色", green: "绿色", purple: "紫色", teal: "青色", gray: "灰色" };
function normalizedMarker(category, value) {
  return category === "flag" ? ({ "🚩": "red", "⚑": "gray", "⚐": "gray" }[value] || value) : value;
}
function markerLabel(category, value) {
  value = normalizedMarker(category, value);
  if (category === "flag" && flagLabels[value]) return `${flagLabels[value]}旗子`;
  if (category === "progress") return value === "start" ? "任务进度：未开始" : value === "done" ? "任务进度：已完成" : `任务进度：${Number(value[0]) * 12.5}%`;
  return `优先级 ${value}`;
}
function markerIcon(category, value, size = 28) {
  value = normalizedMarker(category, value);
  let shape;
  if (category === "flag" && flagColors[value]) {
    shape = `<path fill="${flagColors[value]}" d="M9 0 45 16 15 30V48H9Z"/>`;
  } else if (category === "progress" && markerGroups[1].values.includes(value)) {
    const green = "#00cc55";
    if (value === "done") {
      shape = `<circle cx="24" cy="24" r="24" fill="${green}"/><path d="m12 24 8 8 16-16" fill="none" stroke="white" stroke-width="6"/>`;
    } else {
      const angle = Number(value[0]) * Math.PI / 4;
      const sector = value === "start" ? `<path d="M18 14 34 24 18 34Z" fill="${green}"/>` : `<path d="M24 24V1A23 23 0 ${angle > Math.PI ? 1 : 0} 1 ${24 + 23 * Math.sin(angle)} ${24 - 23 * Math.cos(angle)}Z" fill="${green}"/>`;
      shape = `<circle cx="24" cy="24" r="22.75" fill="white" stroke="${green}" stroke-width="2.5"/>${sector}`;
    }
  } else {
    shape = `<text x="24" y="36" text-anchor="middle" style="font-size:36px;fill:currentColor">${esc(value)}</text>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" class="marker-icon" width="${size}" height="${size}" viewBox="0 0 48 48" aria-hidden="true" focusable="false">${shape}</svg>`;
}
function nodeMarkerIcons(markers, height) {
  const entries = Object.entries(markers || {}), size = 16, gap = 3;
  return entries.map(([category, value], i) => `<g class="node-marker" transform="translate(${8 + i * (size + gap)} ${(height - size) / 2})"><title>${esc(markerLabel(category, value))}</title>${markerIcon(category, value, size)}</g>`).join("");
}

let serial = 20,
  selected = "root",
  current = "launch",
  mode = "online",
  pending = 0,
  zoom = 1,
  undoStack = [],
  redoStack = [],
  dialogKind = "",
  lastFocus = null,
  tabDrag = null,
  drag = null,
  timer = null,
  inlineEdit = null,
  pan = null,
  panX = 0,
  panY = 0;
const seeds = [
  {
    id: "launch",
    title: "新产品发布计划",
    open: true,
    pinned: true,
    nodes: [
      {
        id: "root",
        parent: null,
        text: "新产品发布计划",
        side: 0,
        markers: {},
      },
      {
        id: "a",
        parent: "root",
        text: "发现与定义",
        side: 1,
        markers: { priority: "①" },
      },
      { id: "a1", parent: "a", text: "用户访谈", markers: {} },
      { id: "a2", parent: "a", text: "明确使用场景", markers: {} },
      {
        id: "b",
        parent: "root",
        text: "产品与设计",
        side: 1,
        markers: { flag: "blue" },
      },
      { id: "b1", parent: "b", text: "编辑器交互", markers: {} },
      { id: "b2", parent: "b", text: "首版功能范围", markers: {} },
      { id: "c", parent: "root", text: "开发与验证", side: -1, markers: {} },
      { id: "c1", parent: "c", text: "离线与跨设备同步", markers: {} },
      { id: "c2", parent: "c", text: "上千节点性能", markers: {} },
      { id: "d", parent: "root", text: "发布与复盘", side: -1, markers: {} },
      { id: "d1", parent: "d", text: "体验验收", markers: {} },
      { id: "d2", parent: "d", text: "上线观察", markers: {} },
    ],
  },
  {
    id: "learning",
    title: "阅读与学习",
    open: true,
    pinned: false,
    nodes: [
      { id: "root", parent: null, text: "阅读与学习", markers: {} },
      { id: "l1", parent: "root", text: "正在读的书", side: 1, markers: {} },
      { id: "l2", parent: "root", text: "待实践的想法", side: -1, markers: {} },
    ],
  },
  {
    id: "notes",
    title: "灵感收集",
    open: false,
    pinned: false,
    nodes: [{ id: "root", parent: null, text: "灵感收集", markers: {} }],
  },
];
let maps = clone(seeds),
  trash = [
    {
      id: "old",
      title: "上周的计划",
      deleted: "2026-10-12",
      days: 27,
      nodes: [{ id: "root", parent: null, text: "上周的计划", markers: {} }],
    },
  ];
let snapshots = [
  {
    mapId: "launch",
    label: "今天 14:35",
    note: "合并编辑 · 8 个节点",
    nodes: clone(seeds[0].nodes.slice(0, 8)),
    title: "新产品发布计划",
  },
  {
    mapId: "launch",
    label: "今天 14:30",
    note: "合并编辑 · 5 个节点",
    nodes: clone(seeds[0].nodes.slice(0, 5)),
    title: "新产品发布计划",
  },
  {
    mapId: "launch",
    label: "今天 14:25",
    note: "开始整理 · 1 个节点",
    nodes: [clone(seeds[0].nodes[0])],
    title: "新产品发布计划",
  },
];
const map = () => maps.find((m) => m.id === current),
  node = () => map()?.nodes.find((n) => n.id === selected),
  children = (id) => (map()?.nodes || []).filter((n) => n.parent === id);
function toast(text) {
  $("toast").textContent = text;
  $("toast").hidden = false;
  clearTimeout(timer);
  timer = setTimeout(() => ($("toast").hidden = true), 3400);
}
// 草图按脑图保存内容历史，标签/固定/画布视角不随内容撤销。
function contentState() {
  return { title: map().title, nodes: clone(map().nodes) };
}
function historyEntry() {
  return {
    id: current,
    content: historyContent(contentState()),
    selectedId: selected,
  };
}
function remember() {
  if (!map()) return;
  undoStack.push(historyEntry());
  if (undoStack.length > 100) undoStack.shift();
  redoStack = redoStack.filter((entry) => entry.id !== current);
}
// 只补偿本次操作影响的字段，不把示例远端新增节点一起回滚。
function historyContent(content) {
  return {
    title: content.title,
    nodes: content.nodes.map(({ x, y, ...node }) => node),
  };
}
function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function mergeHistory(before, expected, desired) {
  const result = clone(before),
    now = new Map(result.nodes.map((n) => [n.id, n]));
  const from = new Map(expected.nodes.map((n) => [n.id, n])),
    to = new Map(desired.nodes.map((n) => [n.id, n]));
  if (expected.title !== desired.title) {
    if (result.title !== expected.title)
      throw Error("节点名称已被其他操作更新，未回滚");
    result.title = desired.title;
  }
  for (const [id, old] of from) {
    const target = to.get(id),
      live = now.get(id);
    if (!target) {
      if (!sameValue(live, old)) throw Error("该分支已被其他操作更新，未回滚");
      now.delete(id);
      continue;
    }
    if (!live) throw Error("该节点已被其他操作删除，未回滚");
    for (const key of new Set([...Object.keys(old), ...Object.keys(target)])) {
      if (key === "id") continue;
      if (key === "markers") {
        for (const category of new Set([
          ...Object.keys(old.markers || {}),
          ...Object.keys(target.markers || {}),
        ])) {
          if (sameValue(old.markers?.[category], target.markers?.[category]))
            continue;
          if (!sameValue(live.markers?.[category], old.markers?.[category]))
            throw Error("该标记已被其他操作更新，未回滚");
          live.markers = live.markers || {};
          if (target.markers?.[category] === undefined)
            delete live.markers[category];
          else live.markers[category] = target.markers[category];
        }
      } else if (!sameValue(old[key], target[key])) {
        if (!sameValue(live[key], old[key]))
          throw Error("该属性已被其他操作更新，未回滚");
        if (target[key] === undefined) delete live[key];
        else live[key] = clone(target[key]);
      }
    }
  }
  for (const [id, target] of to) {
    if (from.has(id)) continue;
    if (now.has(id)) throw Error("节点编号已有其他操作占用，未回滚");
    now.set(id, clone(target));
  }
  const common = expected.nodes.filter((n) => to.has(n.id)).map((n) => n.id);
  const targetCommon = desired.nodes
    .filter((n) => from.has(n.id))
    .map((n) => n.id);
  let order = before.nodes.map((n) => n.id).filter((id) => now.has(id));
  if (!sameValue(common, targetCommon)) {
    const currentCommon = order.filter((id) => common.includes(id));
    if (!sameValue(currentCommon, common))
      throw Error("节点顺序已被其他操作更新，未回滚");
    let i = 0;
    order = order.map((id) => (common.includes(id) ? targetCommon[i++] : id));
  }
  // 恢复已删除节点时，按原始前后关系插入；不改变无关远端节点。
  desired.nodes.forEach((n, index) => {
    if (order.includes(n.id)) return;
    const next = desired.nodes
      .slice(index + 1)
      .find((item) => order.includes(item.id));
    if (next) order.splice(order.indexOf(next.id), 0, n.id);
    else order.push(n.id);
  });
  result.nodes = order.map((id) => now.get(id));
  const ids = new Map(result.nodes.map((n) => [n.id, n]));
  if (result.nodes.filter((n) => n.parent === null).length !== 1)
    throw Error("无法安全恢复中心主题");
  for (const n of result.nodes) {
    let p = n;
    const seen = new Set();
    while (p.parent !== null) {
      if (seen.has(p.id) || !ids.has(p.parent))
        throw Error("恢复会影响其他分支，未回滚");
      seen.add(p.id);
      p = ids.get(p.parent);
    }
  }
  return result;
}
function applyHistory(from, to, label) {
  if (!map()) return;
  const index = from.findLastIndex((entry) => entry.id === current);
  if (index < 0) return toast(`当前脑图没有可${label}操作`);
  const entry = from[index],
    before = historyContent(contentState());
  let result;
  try {
    result = mergeHistory(before, entry.expected, entry.content);
  } catch (error) {
    toast(error.message);
    return;
  }
  if (
    [...maps, ...trash].some(
      (item) => item.id !== current && item.title === result.title,
    )
  ) {
    toast("历史名称已被占用，未更改当前内容");
    return;
  }
  to.push({
    id: current,
    content: before,
    expected: clone(result),
    selectedId: selected,
  });
  from.splice(index, 1);
  map().title = result.title;
  map().nodes = result.nodes;
  selected = map().nodes.some((n) => n.id === entry.selectedId)
    ? entry.selectedId
    : null;
  changed(`已${label}当前设备在当前脑图的操作`);
}
function undo() {
  applyHistory(undoStack, redoStack, "撤销");
}
function redo() {
  applyHistory(redoStack, undoStack, "重做");
}
function status(text) {
  $("event").textContent = text;
}
let saveTimer;
function changed(text) {
  pending++;
  updateSync();
  status(text || "布局已自动更新");
  clearTimeout(saveTimer);
  if (mode === "online")
    saveTimer = setTimeout(() => {
      pending = 0;
      updateSync();
    }, 650);
  render();
  const entry = undoStack.at(-1);
  if (entry?.id === current && !entry.expected)
    entry.expected = historyContent(contentState());
}
function updateSync() {
  const fail = mode === "failed",
    off = mode === "offline";
  $("sync").className =
    "sync" + (fail ? " error" : off || pending ? " warn" : "");
  $("sync-text").textContent = fail
    ? "同步失败 · 模拟"
    : off
      ? `离线 · ${pending} 项待同步`
      : pending
        ? `${pending} 项待同步 · 模拟`
        : "已同步 · 模拟";
  $("scenario-note").textContent = fail
    ? "本地修改保留。点击顶部同步状态，可演示手动重试。"
    : off
      ? "现在可继续添加和编辑；切回正常编辑，演示恢复联网。"
      : "这里的云端状态仅用于评审，未连接真实服务。";
}
function visibleNodes() {
  const out = [];
  function visit(n) {
    out.push(n);
    if (!n.collapsed) children(n.id).forEach(visit);
  }
  const root = map()?.nodes.find((n) => n.parent === null);
  if (root) visit(root);
  return out;
}
// 文字宽度、换行与节点尺寸统一计算，供布局、连线、编辑和拖动使用。
let textMeasureContext;
const nodeGeometryCache = new WeakMap();
const graphemeSegmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter("zh", { granularity: "grapheme" }) : null;
function measureNodeText(text, fontSize, root) {
  if (textMeasureContext === undefined)
    textMeasureContext = document.createElement?.("canvas")?.getContext?.("2d") || null;
  if (textMeasureContext) {
    textMeasureContext.font = `${root ? 650 : 400} ${fontSize}px -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif`;
    return textMeasureContext.measureText(text).width;
  }
  // Node 回归没有浏览器画布，以较保守的全角/半角宽度验证布局约束。
  return Array.from(text).reduce((width, character) => width + fontSize * (/^[\x00-\x7f]$/.test(character) ? 0.65 : 1), 0);
}
function nodeMetrics(n) {
  const root = n.parent === null, markerCount = Object.keys(n.markers || {}).length;
  const cached = nodeGeometryCache.get(n);
  if (cached && cached.text === n.text && cached.root === root && cached.markerCount === markerCount) return cached.metrics;
  const fontSize = root ? 15 : 12, lineHeight = root ? 22 : 20;
  const paragraphs = String(n.text).replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  const textLeft = markerCount ? 8 + markerCount * 19 + 6 : 12;
  const naturalWidth = paragraphs.reduce((width, line) => Math.max(width, measureNodeText(line, fontSize, root)), 0);
  const width = Math.ceil(Math.max(root ? 168 : 152, textLeft + fontSize * 4 + 12, Math.min(root ? 320 : 280, textLeft + naturalWidth + 12)));
  const textWidth = width - textLeft - 12, lines = [];
  for (const paragraph of paragraphs) {
    const characters = graphemeSegmenter ? Array.from(graphemeSegmenter.segment(paragraph), (part) => part.segment) : Array.from(paragraph);
    let line = "";
    for (const character of characters) {
      if (line && measureNodeText(line + character, fontSize, root) > textWidth) {
        lines.push(line);
        line = character;
      } else line += character;
    }
    lines.push(line);
  }
  const height = Math.max(root ? 48 : 38, lines.length * lineHeight + 16);
  const metrics = { width, height, textLeft, textWidth, lines, lineHeight, fontSize };
  nodeGeometryCache.set(n, { text: n.text, root, markerCount, metrics });
  return metrics;
}
function layout() {
  const m = map();
  if (!m) return;
  const root = m.nodes.find((n) => n.parent === null);
  if (!root) return;
  const descendants = new Map();
  for (const item of m.nodes) {
    if (!descendants.has(item.parent)) descendants.set(item.parent, []);
    descendants.get(item.parent).push(item);
  }
  const visibleChildren = (n) => n.collapsed ? [] : descendants.get(n.id) || [];
  const spans = new Map(), gap = 34;
  function span(n) {
    if (!spans.has(n.id)) spans.set(n.id, Math.max(nodeMetrics(n).height + gap, visibleChildren(n).reduce((sum, item) => sum + span(item), 0)));
    return spans.get(n.id);
  }
  root.x = 550;
  root.y = 325;
  const first = visibleChildren(root);
  let idx = 0;
  first.forEach((n) => { if (!n.side) n.side = idx++ % 2 === 0 ? 1 : -1; });
  for (const side of [1, -1]) {
    const list = first.filter((n) => n.side === side), widths = [];
    function measureColumns(n, depth) {
      widths[depth] = Math.max(widths[depth] || 0, nodeMetrics(n).width);
      for (const item of visibleChildren(n)) measureColumns(item, depth + 1);
    }
    list.forEach((n) => measureColumns(n, 1));
    const columns = [550];
    for (let depth = 1; depth < widths.length; depth++) {
      const previous = depth === 1 ? nodeMetrics(root).width : widths[depth - 1];
      columns[depth] = columns[depth - 1] + side * (previous / 2 + widths[depth] / 2 + (depth === 1 ? 85 : 50));
    }
    function place(n, depth, center) {
      n.side = side;
      n.x = columns[depth];
      n.y = center;
      const cs = visibleChildren(n);
      let cy = center - cs.reduce((sum, item) => sum + span(item), 0) / 2;
      for (const item of cs) {
        const height = span(item);
        place(item, depth + 1, cy + height / 2);
        cy += height;
      }
    }
    let y = root.y - list.reduce((sum, n) => sum + span(n), 0) / 2;
    for (const n of list) {
      const height = span(n);
      place(n, 1, y + height / 2);
      y += height;
    }
  }
}
function color(n) {
  let p = n;
  while (p.parent && p.parent !== "root")
    p = map().nodes.find((x) => x.id === p.parent) || p;
  return (
    { a: "#659cb1", b: "#88a277", c: "#aa8cb2", d: "#c6a36b" }[p.id] ||
    "#7e9dad"
  );
}
function draw() {
  const m = map(),
    svg = $("graph");
  if (!m) {
    svg.innerHTML =
      '<text x="550" y="325" text-anchor="middle" fill="#9aa9b4" font-size="16">从左侧打开脑图，或新建一张开始整理</text>';
    return;
  }
  layout();
  const ns = visibleNodes(),
    scale = `translate(${panX + 550 - 550 * zoom} ${panY + 325 - 325 * zoom}) scale(${zoom})`;
  let html = `<g id="graph-content" transform="${scale}">`;
  ns.forEach((n) => {
    if (!n.parent) return;
    const p = m.nodes.find((x) => x.id === n.parent);
    if (!p) return;
    const sx = p.x + nodeMetrics(p).width / 2 * n.side,
      ex = n.x - nodeMetrics(n).width / 2 * n.side;
    html += `<path class="edge" stroke="${color(n)}" d="M ${sx} ${p.y} C ${(sx + ex) / 2} ${p.y}, ${(sx + ex) / 2} ${n.y}, ${ex} ${n.y}"/>`;
  });
  ns.forEach((n) => {
    const root = !n.parent,
      { width: w, height: h, textLeft, textWidth, lines, lineHeight } = nodeMetrics(n);
    const marks = nodeMarkerIcons(n.markers, h), textX = textLeft + textWidth / 2;
    const firstLineY = (h - (lines.length - 1) * lineHeight) / 2;
    const text = lines.map((line, index) => `<tspan x="${textX}" y="${firstLineY + index * lineHeight}">${esc(line) || "&#8203;"}</tspan>`).join("");
    html += `<g class="node ${root ? "root" : ""} ${selected === n.id ? "selected" : ""} ${inlineEdit?.id === n.id ? "editing" : ""}" data-node="${esc(n.id)}" tabindex="0" role="button" aria-label="节点 ${esc(n.text)}" transform="translate(${n.x - w / 2} ${n.y - h / 2})"><rect width="${w}" height="${h}" rx="${root ? 10 : 7}" style="${root ? "" : `stroke:${selected === n.id ? "#4d8eb9" : color(n)}66`}"/><text class="node-label" text-anchor="middle" dominant-baseline="central" xml:space="preserve" style="white-space:pre">${text}</text>${marks}${inlineEdit?.id === n.id ? `<foreignObject x="${textLeft - 4}" y="6" width="${textWidth + 8}" height="${h - 12}"><textarea xmlns="http://www.w3.org/1999/xhtml" id="inline-node-editor" class="inline-editor" aria-label="编辑节点文字" spellcheck="false">${esc(n.text)}</textarea></foreignObject>` : ""}${children(n.id).length ? `<g class="fold" data-fold="${esc(n.id)}" transform="translate(${n.side === -1 ? -19 : w + 4} ${h / 2 - 8})"><rect width="15" height="16" rx="6"/><text x="7.5" y="11" text-anchor="middle">${n.collapsed ? "+" : "−"}</text></g>` : ""}</g>`;
  });
  svg.innerHTML = html + "</g>";
  $("node-count").textContent =
    `${m.nodes.length} 个节点 · ${ns.length} 个可见`;
  if (inlineEdit) bindInlineEditor();
  applyViewport();
}
function render(redraw = true) {
  const m = map();
  $("files").innerHTML = maps.length
    ? maps
        .map(
          (x) =>
            `<button class="file ${current === x.id ? "active" : ""}" data-map="${x.id}"><span class="fileicon">▧</span><span class="name">${esc(x.title)}</span></button>`,
        )
        .join("")
    : '<div class="filesempty">还没有脑图</div>';
  $("tabs").innerHTML =
    maps
      .filter((x) => x.open)
      .map(
        (x) =>
          `<button draggable="true" class="tab ${current === x.id ? "active" : ""}" data-tab="${x.id}"><span class="pin">${x.pinned ? "◆" : "◇"}</span><span class="tabname">${esc(x.title)}</span><span class="close" data-close="${x.id}" role="button" aria-label="关闭 ${esc(x.title)}">×</span></button>`,
      )
      .join("") + '<button class="addtab" aria-label="新建脑图">＋</button>';
  $("count").textContent = `· ${maps.length}`;
  $("trash-count").textContent = trash.length ? `(${trash.length})` : "";
  $("caption").textContent = m?.title || "未打开脑图";
  const n = node();
  $("node-label").value = n?.text || "";
  $("node-label").disabled = !n;
  $("node-level").textContent = !n
    ? "—"
    : !n.parent
      ? "中心主题"
      : n.parent === "root"
        ? "一级分支"
        : "子主题";
  $("selection-note").textContent = !n
    ? "点击节点查看或编辑。"
    : !n.parent
      ? "中心主题与脑图名称同步更新。"
      : "删除此节点会同时删除其子分支。";
  $("delete-node").disabled = !n || !n.parent;
  $("fold").disabled = !n || children(n.id).length === 0;
  const branches = foldingBranches(n);
  const canExpand = branches.some((item) => item.collapsed), foldAllButton = $("fold-all");
  foldAllButton.disabled = !branches.length;
  foldAllButton.textContent = branches.length ? (canExpand ? "全部展开" : "全部折叠") : "全部折叠 / 展开";
  foldAllButton.title = branches.length ? `${canExpand ? "展开" : "折叠"}选中节点下的所有子节点` : "请先选择包含子节点的节点";
  foldAllButton.setAttribute("aria-label", foldAllButton.title);
  $("edit-node").disabled = !n;
  $("add").disabled = !n;
  $("sibling").disabled = !n || !n.parent;
  $("undo").disabled = !undoStack.some((x) => x.id === current);
  $("redo").disabled = !redoStack.some((x) => x.id === current);
  for (const { category, values } of markerGroups) {
    $(category + "-markers").innerHTML = values
      .map((value) => {
        const active = normalizedMarker(category, n?.markers?.[category]) === value;
        const label = markerLabel(category, value);
        return `<button class="marker ${active ? "active" : ""}" data-category="${category}" data-mark="${esc(value)}" title="${esc(label)}" aria-label="${esc(label)}" aria-pressed="${active}" ${!n ? "disabled" : ""}>${markerIcon(category, value)}</button>`;
      })
      .join("");
  }
  if (redraw) draw();
  else
    $("graph")
      .querySelectorAll("[data-node]")
      .forEach((g) =>
        g.classList.toggle("selected", g.dataset.node === selected),
      );
}
// 视角平移使用 SVG 坐标转换，只更新视图层，不写入节点位置或同步队列。
function svgPoint(event) {
  const svg = $("graph"),
    matrix = svg.getScreenCTM();
  return matrix
    ? new DOMPoint(event.clientX, event.clientY).matrixTransform(
        matrix.inverse(),
      )
    : null;
}
function applyViewport() {
  const svg = $("graph"),
    content = $("graph-content");
  if (content)
    content.setAttribute(
      "transform",
      `translate(${panX + 550 - 550 * zoom} ${panY + 325 - 325 * zoom}) scale(${zoom})`,
    );
  const matrix = svg.getScreenCTM();
  if (matrix)
    $("canvas").style.backgroundPosition =
      `${panX * matrix.a}px ${panY * matrix.d}px`;
}
function stopPan(event) {
  if (!pan) return false;
  const moved = pan.moved;
  pan = null;
  $("graph").classList.remove("is-panning");
  if (event && $("graph").hasPointerCapture(event.pointerId))
    $("graph").releasePointerCapture(event.pointerId);
  if (moved) status("画布视角已平移 · 不改变节点位置或父子关系");
  return true;
}
function openMap(id) {
  const m = maps.find((x) => x.id === id);
  if (!m) return;
  current = id;
  m.open = true;
  selected = null;
  zoom = 1;
  panX = 0;
  panY = 0;
  render();
  status("已切换脑图；保留各图内容");
}
function unique(title) {
  let t = title || "未命名脑图",
    i = 2;
  while ([...maps, ...trash].some((m) => m.title === t))
    t = `${title || "未命名脑图"}（${i++}）`;
  return t;
}
function create(title = "未命名脑图", nodes = null) {
  const name = unique(title),
    id = "m" + ++serial;
  maps.push({
    id,
    title: name,
    open: true,
    pinned: false,
    nodes: nodes || [{ id: "root", parent: null, text: name, markers: {} }],
  });
  current = id;
  panX = 0;
  panY = 0;
  zoom = 1;
  map().nodes.find((n) => !n.parent).text = name;
  selected = "root";
  changed("新建脑图 · 自动布局");
  return name;
}
function rename(id, text) {
  const m = map(),
    n = m?.nodes.find((x) => x.id === id);
  if (!n) return;
  const value = text.trim() || n.text;
  if (
    !n.parent &&
    [...maps, ...trash].some((x) => x.id !== m.id && x.title === value)
  ) {
    toast("名称已存在，名称和中心主题保持不变");
    render();
    return;
  }
  if (value === n.text) return;
  remember();
  n.text = value;
  if (!n.parent) m.title = value;
  changed("文字已更新 · 布局随节点变化重新计算");
}
function add(sibling = false) {
  const n = node();
  if (!n) return toast("先选中一个节点");
  if (sibling && !n.parent)
    return toast("中心主题没有同级主题，可按 Tab 新增子主题");
  const parent = sibling ? n.parent : n.id;
  remember();
  const id = "n" + ++serial,
    next = { id, parent, text: "新主题", side: n.side, markers: {} };
  if (sibling) map().nodes.splice(map().nodes.indexOf(n) + 1, 0, next);
  else map().nodes.push(next);
  map().nodes.find((item) => item.id === parent).collapsed = false;
  selected = id;
  changed(sibling ? "新增同级主题 · 自动重排" : "新增子主题 · 自动重排");
}
function addParent() {
  const n = node();
  if (!n) return toast("先选中一个节点");
  if (!n.parent) return toast("中心主题不能新增父主题");
  remember();
  const index = map().nodes.indexOf(n),
    id = "parent" + ++serial;
  map().nodes.splice(index, 0, {
    id,
    parent: n.parent,
    text: "新父主题",
    side: n.side,
    markers: {},
  });
  n.parent = id;
  selected = id;
  changed("已在当前主题上方插入父主题，原有子分支保留");
}
function moveSibling(direction) {
  const n = node();
  if (!n) return toast("先选中一个节点");
  if (!n.parent) return toast("中心主题不能在同级中移动");
  // 同级顺序覆盖同一父主题的全部子节点，不能把另一侧兄弟主题排除。
  const peers = children(n.parent);
  const index = peers.findIndex((item) => item.id === n.id),
    other = peers[index + direction];
  if (!other)
    return toast(
      direction < 0 ? "已经是第一个同级主题" : "已经是最后一个同级主题",
    );
  remember();
  // 一级分支跨越左右侧槽位时连同侧向交换，防止只改数组而画面不动。
  if (n.parent === map().nodes.find((item) => item.parent === null).id) {
    [n.side, other.side] = [other.side, n.side];
  }
  const from = map().nodes.indexOf(n),
    to = map().nodes.indexOf(other);
  [map().nodes[from], map().nodes[to]] = [map().nodes[to], map().nodes[from]];
  changed(
    direction < 0
      ? "当前主题已向上移动一位 · 父子关系不变"
      : "当前主题已向下移动一位 · 父子关系不变",
  );
  // 重排会重绘 SVG，保持画布焦点，连续按键无需再次点击节点。
  $("graph").focus?.({ preventScroll: true });
}
function foldingBranches(root) {
  if (!root || !map()) return [];
  const byParent = new Map();
  for (const n of map().nodes) {
    if (!byParent.has(n.parent)) byParent.set(n.parent, []);
    byParent.get(n.parent).push(n);
  }
  const branches = [], stack = [root];
  while (stack.length) {
    const item = stack.pop(), cs = byParent.get(item.id) || [];
    if (cs.length) { branches.push(item); stack.push(...cs); }
  }
  return branches;
}
function setBranchFold(root, collapse) {
  const branches = foldingBranches(root);
  if (!branches.length || !branches.some((n) => !!n.collapsed !== collapse)) return;
  remember();
  for (const n of branches) n.collapsed = collapse;
  if (collapse) selected = root.id;
  changed(`选中节点下的全部子分支已${collapse ? "折叠" : "展开"}`);
}
// 普通加减号只切换本节点，不改写后代的折叠状态。
function fold() {
  const n = node();
  if (!n || !children(n.id).length) return;
  remember();
  n.collapsed = !n.collapsed;
  changed(n.collapsed ? "当前节点已折叠，保留后代折叠状态" : "当前节点已展开一级，保留后代折叠状态");
}
function foldAll(collapse) {
  const root = node();
  if (!root) return;
  const branches = foldingBranches(root);
  if (!branches.length) return;
  setBranchFold(root, typeof collapse === "boolean" ? collapse : !branches.some((n) => n.collapsed));
}
// 缩放只改变视角。保持鼠标下的世界坐标不动，不重绘节点以免丢失输入草稿。
function setCanvasZoom(nextZoom, anchor = { x: 550, y: 325 }) {
  if (!map() || !Number.isFinite(nextZoom)) return;
  const next =
    Math.round(Math.min(1.6, Math.max(0.4, nextZoom)) * 10000) / 10000;
  if (next === zoom) return;
  const worldX = (anchor.x - panX - 550 + 550 * zoom) / zoom;
  const worldY = (anchor.y - panY - 325 + 325 * zoom) / zoom;
  panX = anchor.x - 550 + 550 * next - worldX * next;
  panY = anchor.y - 325 + 325 * next - worldY * next;
  zoom = next;
  $("zoom-value").textContent = Math.round(zoom * 100) + "%";
  applyViewport();
  status(`画布缩放 ${Math.round(zoom * 100)}% · 仅本机视角`);
}
function changeZoom(delta) {
  setCanvasZoom(Math.round((zoom + delta) * 10) / 10);
}
function zoomCanvasOnWheel(event) {
  if (!$("overlay").hidden || textInput(event.target) || !map()) return;
  if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return;
  event.preventDefault();
  event.stopPropagation();
  if (drag?.moved || pan?.moved) return;
  const point = svgPoint(event);
  if (!point) return;
  const unit =
    event.deltaMode === 1
      ? 16
      : event.deltaMode === 2
        ? $("graph").getBoundingClientRect().height
        : 1;
  const pixels = Math.min(160, Math.max(-160, event.deltaY * unit));
  setCanvasZoom(zoom * Math.exp(-pixels * 0.002), point);
}
$("graph").addEventListener("wheel", zoomCanvasOnWheel, { passive: false });
function manualSave() {
  if (inlineEdit) finishInlineEdit(true);
  if (!map()) return toast("先打开一张脑图");
  clearTimeout(saveTimer);
  updateSync();
  if (mode === "offline")
    return toast("离线修改保留在草图内存中，模拟联网后再同步；刷新会重置");
  if (mode === "failed") {
    toast("模拟保存失败，修改仍保留；可从顶部状态手动重试");
    return;
  }
  status("已手动触发保存 · 草图模拟，刷新会重置");
  saveTimer = setTimeout(() => {
    pending = 0;
    updateSync();
    toast("模拟保存完成；未连接真实云端，刷新会重置");
  }, 400);
}
function removeNode() {
  const n = node();
  if (!n) return;
  if (!n.parent) return toast("中心主题不能直接删除，请从脑图管理中删除整张图");
  remember();
  const ids = new Set([n.id]);
  let old = 0;
  while (old !== ids.size) {
    old = ids.size;
    map().nodes.forEach((x) => {
      if (ids.has(x.parent)) ids.add(x.id);
    });
  }
  map().nodes = map().nodes.filter((x) => !ids.has(x.id));
  selected = n.parent;
  changed("已删除整条分支 · 可按 ⌘Z 恢复");
  toast(`已删除 ${ids.size} 个节点，可撤销`);
}

function show(kind, title, body) {
  if (dialogKind === "import") importRequest++;
  lastFocus = document.activeElement;
  dialogKind = kind;
  $("dialog-title").textContent = title;
  $("dialog-body").innerHTML = body;
  $("overlay").hidden = false;
  setTimeout(() => {
    $("dialog-body").querySelector("input,textarea,button")?.focus();
  }, 10);
}
function close() {
  if (dialogKind === "import") importRequest++;
  $("overlay").hidden = true;
  dialogKind = "";
  lastFocus?.focus?.();
}
function dialog(kind) {
  if (kind === "import") {
    show(
      kind,
      "导入内容",
      `<p>把已有的大纲和想法带进来。先完整解析和校验，失败时原有脑图保持不变。</p><div class="choice-row"><span class="symbol">X</span><div class="grow"><b>XMind 8 文件</b><small>选择真实 .xmind 文件；多张脑图分别在新标签打开</small></div><button id="pick-xmind">选择文件</button></div><input id="xmind-file" class="sr-only" type="file" accept=".xmind,application/zip" aria-label="选择 XMind 文件"><div class="choice-row"><span class="symbol">▤</span><div class="grow"><b>演示文件导入</b><small>固定示例，不读取真实文件</small></div><button id="xmind-demo">打开演示</button></div><p class="small">当前支持 XMind 8 文件，不支持新版 XMind 格式。文件只在本机读取。导入后仍在草图内存中，刷新会重置。</p><div id="import-feedback" class="warning" role="status" aria-live="polite" hidden></div><label for="paste-source">粘贴内容</label><select id="paste-source"><option>Markdown / 纯文本大纲</option></select><textarea id="paste-text" aria-label="待导入大纲"># 发布准备\n- 内容检查\n  - 文案与素材\n  - 版本说明\n- 体验验证\n  - Chrome\n  - Safari</textarea><div class="review-choice">${node() ? `将插入「${esc(node().text)}」的子分支。` : "当前未选中节点，将新建脑图。"}<br>节点文字编辑中粘贴只插入文字。</div><div class="modal-footer"><button id="cancel-import">取消</button><button class="primary" id="do-paste">插入内容</button></div>`,
    );
    $("cancel-import").onclick = close;
    $("do-paste").onclick = () => pasteOutline($("paste-text").value);
    $("pick-xmind").onclick = () => $("xmind-file").click();
    $("xmind-file").onchange = () => {
      const file = $("xmind-file").files?.[0];
      if (file) void importXmindFile(file);
    };
    $("xmind-demo").onclick = () => {
      const drafts = [
        { nodes: [
          { id: "root", parent: null, text: "发布准备", markers: {} },
          { id: "file1", parent: "root", text: "检查内容", markers: { priority: "①" } },
          { id: "file2", parent: "root", text: "验证体验", markers: {} },
        ] },
        { nodes: [
          { id: "root", parent: null, text: "项目复盘", markers: {} },
          { id: "file3", parent: "root", text: "记录收获", markers: {} },
        ] },
      ];
      try { reportImport(commitImportedMaps(drafts), { ignored: [], warnings: [] }); }
      catch (error) { importFeedback(`导入失败：${error.message}；原有脑图未改变。`); }
    };
  } else if (kind === "history") {
    show(
      kind,
      "版本历史 <模拟>",
      `<p>连续编辑每 5 分钟合并保存，最多保留 10 个版本。离开时补存未归档的修改。</p><div class="small muted">当前草图使用固定示例版本；未运行定时保存。</div>${snapshots.map((v, i) => (v.mapId !== current ? "" : `<div class="choice-row"><span class="symbol">◷</span><div class="grow"><b>${esc(v.label)}</b><small>${esc(v.note)}</small></div><button data-version="${i}">恢复此版本</button></div>`)).join("") || '<div class="blank">这张脑图还没有历史版本</div>'}`,
    );
    $("dialog-body")
      .querySelectorAll("[data-version]")
      .forEach(
        (b) => (b.onclick = () => restoreVersion(Number(b.dataset.version))),
      );
  } else if (kind === "trash") {
    show(
      kind,
      "回收站",
      `<p>删除的脑图保留 30 天，期间继续占用名称。永久删除后释放名称。</p>${trash.length ? trash.map((m) => `<div class="choice-row"><span class="symbol">▧</span><div class="grow"><b>${esc(m.title)}</b><small>${esc(m.deleted)} 删除 · 剩余 ${m.days} 天</small></div><button data-restore="${m.id}">恢复</button><button data-purge="${m.id}" class="danger">永久删除</button></div>`).join("") : '<div class="blank">回收站为空</div>'}`,
    );
    $("dialog-body")
      .querySelectorAll("[data-restore]")
      .forEach(
        (b) =>
          (b.onclick = () => {
            const i = trash.findIndex((x) => x.id === b.dataset.restore);
            const m = trash.splice(i, 1)[0];
            delete m.deleted;
            delete m.days;
            m.open = false;
            maps.push(m);
            render();
            dialog("trash");
            toast("脑图已恢复，可从左侧打开");
          }),
      );
    $("dialog-body")
      .querySelectorAll("[data-purge]")
      .forEach((b) => (b.onclick = () => confirmPurge(b.dataset.purge)));
  } else if (kind === "backup") {
    show(
      kind,
      "备份与恢复",
      `<p>下载 JSON 备份，包含节点、常用标记、折叠状态及标签顺序/固定状态。包含折叠状态是本草图的待评审建议。</p><div class="choice-row"><span class="symbol">↓</span><div class="grow"><b>当前脑图</b><small>${esc(map()?.title || "尚未打开脑图")}</small></div><button id="backup-one" ${!map() ? "disabled" : ""}>下载 JSON</button></div><div class="choice-row"><span class="symbol">↓</span><div class="grow"><b>整个个人空间</b><small>${maps.length} 张脑图 · 不含历史版本和回收站</small></div><button id="backup-all">下载 JSON</button></div><label>从 JSON 恢复</label><input type="file" id="backup-file" accept=".json,application/json" aria-label="选择 JSON 备份"><div class="review-choice">新建脑图副本，不覆盖现有图。保留现有标签，追加备份里已打开的标签并保留相对顺序和固定状态。</div><button class="wide" id="backup-demo">演示重名备份导入</button>`,
    );
    $("backup-one").onclick = () => download(false);
    $("backup-all").onclick = () => download(true);
    $("backup-demo").onclick = () =>
      importBackup({
        format: "mindme-prototype",
        version: 1,
        maps: [clone(seeds[0])],
      });
    $("backup-file").onchange = async (e) => {
      try {
        const f = e.target.files[0];
        if (f) importBackup(JSON.parse(await f.text()));
      } catch {
        toast("文件无法识别，没有更改现有脑图");
      }
    };
  } else if (kind === "login") {
    show(
      kind,
      "个人空间",
      `<p>只允许指定 Google 账号访问。此处演示访问状态，不发起真实登录。</p><div class="choice-row"><span class="symbol">G</span><div class="grow"><b>指定的 Google 账号</b><small>部署时配置，草图不收集账号信息</small></div><span class="pill">允许访问</span></div><div class="modal-footer"><button id="denied">查看未授权状态</button><button class="primary" id="login-ok">进入个人空间（模拟）</button></div>`,
    );
    $("login-ok").onclick = () => {
      close();
      toast("演示：指定账号进入个人空间");
    };
    $("denied").onclick = () =>
      show(
        "denied",
        "此账号暂无访问权限",
        '<p>请使用指定的 Google 账号登录。</p><div class="modal-footer"><button class="primary" id="switch-account">切换账号（模拟）</button></div>',
      ) || void 0;
  } else if (kind === "more") {
    show(
      kind,
      "脑图管理",
      `<p>${esc(map()?.title || "未打开脑图")}</p><div class="split-actions"><button id="rename-map" ${!map() ? "disabled" : ""}>重命名</button><button id="pin-map" ${!map() ? "disabled" : ""}>${map()?.pinned ? "取消固定" : "固定标签"}</button><button class="danger" id="trash-map" ${!map() ? "disabled" : ""}>移入回收站</button></div><p class="note">标签可拖动排序。关闭标签不删除脑图，也不会强制关闭另一设备上的标签（模拟说明）。</p><div class="split-actions"><button id="more-backup">备份与恢复</button><button id="more-trash">回收站</button></div><label>节点操作</label><div class="split-actions"><button id="more-parent" ${!node()?.parent ? "disabled" : ""}>新增父主题</button><button id="more-up" ${!node()?.parent ? "disabled" : ""}>同级上移</button><button id="more-down" ${!node()?.parent ? "disabled" : ""}>同级下移</button><button id="more-fold-all" ${!node() || !children(node().id).length ? "disabled" : ""}>折叠 / 展开全部子分支</button></div>`,
    );
    for (const [id, action] of [
      ["more-parent", addParent],
      ["more-up", () => moveSibling(-1)],
      ["more-down", () => moveSibling(1)],
      ["more-fold-all", foldAll],
    ]) {
      $(id).onclick = () => {
        close();
        action();
      };
    }
    $("more-backup").onclick = () => dialog("backup");
    $("more-trash").onclick = () => dialog("trash");
    $("rename-map").onclick = () => {
      close();
      editNode("root");
    };
    $("pin-map").onclick = () => {
      map().pinned = !map().pinned;
      render();
      close();
      toast("标签固定状态已更新");
    };
    $("trash-map").onclick = () => {
      const m = map();
      trash.push({ ...clone(m), deleted: "2026-10-15", days: 30 });
      maps = maps.filter((x) => x.id !== current);
      current = maps.find((x) => x.open)?.id || null;
      selected = null;
      close();
      render();
      toast("已移入回收站，30 天内可恢复");
    };
  } else if (kind === "sync") {
    show(
      kind,
      "保存与同步 <模拟>",
      `<p>当前状态：${esc($("sync-text").textContent)}</p><div class="choice-row"><div class="grow"><b>本地修改</b><small>${pending} 项待同步 · 云端状态仅为演示</small></div><button id="retry">${mode === "offline" ? "恢复联网（模拟）" : "立即重试（模拟）"}</button></div><div class="review-choice">离线时继续编辑；重试不会丢弃本地修改。同步失败、未授权与本地保存失败会分别提示。</div>`,
    );
    $("retry").onclick = () => {
      mode = "online";
      $("scenario").value = "online";
      close();
      updateSync();
      setTimeout(() => {
        pending = 0;
        updateSync();
        toast("演示：本地修改已同步");
      }, 800);
    };
  }
}
// 在节点自身挂载文字输入区，不复用其他功能的对话框。
function editNode(id = selected) {
  const n = map()?.nodes.find((x) => x.id === id);
  if (!n) return;
  if (inlineEdit) finishInlineEdit(true);
  if (!$("overlay").hidden) close();
  selected = id;
  drag = null;
  inlineEdit = { id, mapId: current };
  render();
  const input = $("inline-node-editor");
  input?.focus();
  input?.select();
  status("节点内编辑 · Enter 保存 · Esc 取消 · Shift+Enter 换行");
}
function finishInlineEdit(save) {
  if (!inlineEdit) return;
  const state = inlineEdit,
    input = $("inline-node-editor"),
    value = input?.value;
  inlineEdit = null;
  if (save && current === state.mapId && value !== undefined)
    rename(state.id, value);
  render();
  if (!save) status("已取消编辑，节点文字保持不变");
}
function bindInlineEditor() {
  const input = $("inline-node-editor");
  if (!input) return;
  for (const name of [
    "pointerdown",
    "pointermove",
    "pointerup",
    "dblclick",
    "click",
  ])
    input.addEventListener(name, (e) => e.stopPropagation());
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.isComposing || e.keyCode === 229) return;
    if (e.metaKey && !e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      manualSave();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      finishInlineEdit(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finishInlineEdit(false);
    }
  };
  input.onblur = () => finishInlineEdit(true);
}

const branchMime = "application/x-mindme-branch+json";
function exportBranch() {
  const root = node();
  if (!root) return null;
  const nodes = [];
  function visit(n, parent) {
    nodes.push({
      id: n.id,
      parent,
      text: n.text,
      markers: clone(n.markers || {}),
      collapsed: Boolean(n.collapsed),
    });
    children(n.id).forEach((child) => visit(child, n.id));
  }
  visit(root, null);
  return { format: "mindme-branch", version: 1, rootId: root.id, nodes };
}
function branchText(payload) {
  const lines = [];
  function visit(n, depth) {
    lines.push("  ".repeat(depth) + "- " + n.text.replace(/\r?\n/g, " "));
    payload.nodes
      .filter((child) => child.parent === n.id)
      .forEach((child) => visit(child, depth + 1));
  }
  visit(
    payload.nodes.find((n) => n.id === payload.rootId),
    0,
  );
  return lines.join("\n");
}
function validateBranch(payload) {
  if (
    payload?.format !== "mindme-branch" ||
    payload.version !== 1 ||
    !Array.isArray(payload.nodes) ||
    !payload.nodes.length ||
    payload.nodes.length > 10000
  )
    return false;
  const ids = new Set();
  for (const n of payload.nodes) {
    if (
      typeof n.id !== "string" ||
      ids.has(n.id) ||
      typeof n.text !== "string" ||
      (n.parent !== null && typeof n.parent !== "string")
    )
      return false;
    if (
      !n.markers ||
      typeof n.markers !== "object" ||
      Array.isArray(n.markers) ||
      Object.values(n.markers).some((v) => typeof v !== "string")
    )
      return false;
    ids.add(n.id);
  }
  const roots = payload.nodes.filter((n) => n.parent === null);
  if (roots.length !== 1 || roots[0].id !== payload.rootId) return false;
  const byId = new Map(payload.nodes.map((n) => [n.id, n])),
    visited = new Set(),
    active = new Set();
  function visit(id) {
    if (active.has(id)) return false;
    if (visited.has(id)) return true;
    active.add(id);
    const n = byId.get(id);
    if (n.parent !== null && (!byId.has(n.parent) || !visit(n.parent)))
      return false;
    active.delete(id);
    visited.add(id);
    return true;
  }
  try {
    return payload.nodes.every((n) => visit(n.id));
  } catch {
    return false;
  }
}
function insertBranch(payload) {
  if (!validateBranch(payload))
    return toast("剪贴板结构无法识别，未修改当前脑图");
  const root = payload.nodes.find((n) => n.id === payload.rootId),
    target = node();
  const ids = new Map(payload.nodes.map((n) => [n.id, "paste" + ++serial]));
  const nodes = payload.nodes.map((n) => ({
    id: ids.get(n.id),
    parent: n.parent === null ? target?.id || null : ids.get(n.parent),
    text: n.text,
    markers: clone(n.markers),
    collapsed: Boolean(n.collapsed),
  }));
  if (!target) {
    const rootId = ids.get(payload.rootId);
    nodes.forEach((n) => {
      if (n.parent === rootId) n.parent = "root";
      if (n.id === rootId) n.id = "root";
    });
    create(root.text || "未命名脑图", nodes);
  } else {
    remember();
    map().nodes.push(...nodes);
    target.collapsed = false;
    selected = ids.get(payload.rootId);
    changed("已粘贴完整子分支 · 原有内容保持不变");
  }
  toast(`已粘贴 ${payload.nodes.length} 个节点，文字、层级和标记保留`);
}
// 文件解析完成前不写入模型；同一批脑图、名称和标签一次提交。
let importRequest = 0;
function parseOutline(text) {
  return MindmeImport.parseOutline(text);
}
function importTransaction(apply) {
  const before = { maps: clone(maps), current, selected, serial, pending, zoom, panX, panY, undoStack: clone(undoStack), redoStack: clone(redoStack) };
  try {
    apply();
    changed("导入完成 · 原有内容保留，布局自动更新");
  } catch (error) {
    clearTimeout(saveTimer);
    ({ maps, current, selected, serial, pending, zoom, panX, panY, undoStack, redoStack } = before);
    try { render(); updateSync(); } catch { /* 保留原始失败原因，模型已还原。 */ }
    throw error;
  }
}
function commitImportedMaps(drafts) {
  MindmeImport.validateDrafts(drafts);
  const names = new Set([...maps, ...trash].map((item) => item.title));
  let nextSerial = serial;
  const imported = drafts.map((draft) => {
    const nodes = clone(draft.nodes), root = nodes.find((item) => item.parent === null);
    const base = root.text.trim() || "未命名脑图";
    let title = base, suffix = 2;
    while (names.has(title)) title = `${base}（${suffix++}）`;
    names.add(title);
    root.text = title;
    return { id: "m" + ++nextSerial, title, open: true, pinned: false, nodes };
  });
  importTransaction(() => {
    maps = [...maps, ...imported];
    serial = nextSerial;
    current = imported.at(-1).id;
    selected = imported.at(-1).nodes.find((item) => item.parent === null).id;
    zoom = 1; panX = 0; panY = 0;
  });
  return imported.length;
}
function importFeedback(message) {
  if (dialogKind === "import") {
    $("import-feedback").hidden = false;
    $("import-feedback").textContent = message;
  } else toast(message);
}
function reportImport(count, result) {
  close();
  if (!result.ignored.length && !result.warnings.length) return toast(`已导入 ${count} 张脑图`);
  show("import-result", "导入完成", `<p>已导入 ${count} 张脑图。文字、层级及可识别标记已保留。</p><div class="warning">${result.ignored.length ? `<b>已忽略的标记</b><ul>${result.ignored.map((id) => `<li>${esc(id)}</li>`).join("")}</ul>` : ""}${result.warnings.map((warning) => `<p>${esc(warning)}</p>`).join("")}</div><div class="modal-footer"><button id="import-result-close" class="primary">知道了</button></div>`);
  $("import-result-close").onclick = close;
}
async function importXmindFile(file) {
  const request = ++importRequest;
  for (const id of ["pick-xmind", "do-paste", "xmind-demo", "xmind-file"]) $(id).disabled = true;
  importFeedback("正在解析文件；完成前可关闭窗口取消导入。");
  try {
    const result = await MindmeImport.parseXmindFile(file);
    if (request !== importRequest || dialogKind !== "import") return;
    const count = commitImportedMaps(result.drafts);
    reportImport(count, result);
  } catch (error) {
    if (request === importRequest && dialogKind === "import")
      importFeedback(`导入失败：${error instanceof Error ? error.message : "文件无法解析"}；原有脑图未改变。`);
  } finally {
    if (request === importRequest && dialogKind === "import") {
      for (const id of ["pick-xmind", "do-paste", "xmind-demo", "xmind-file"]) $(id).disabled = false;
      $("xmind-file").value = "";
    }
  }
}
function pasteOutline(text) {
  try {
    const parsed = parseOutline(text);
    if (!parsed.length) return importFeedback("没有可导入内容，请输入大纲。");
    const target = node();
    if (target) {
      if (map().nodes.length + parsed.length > MindmeImport.limits.nodes) throw new Error("合并后超过本次 5000 节点上限，请拆分导入");
      const draft = { nodes: [{ id: "import-root", parent: null, text: "导入", markers: {} }, ...parsed.map((item) => ({ ...item, parent: item.parent === null ? "import-root" : item.parent }))] };
      MindmeImport.validateDrafts([draft]);
      let parent = target, parentDepth = 0;
      while (parent.parent !== null) { parent = map().nodes.find((item) => item.id === parent.parent); parentDepth++; }
      const depths = new Map([["import-root", parentDepth]]);
      for (const item of draft.nodes.slice(1)) {
        const depth = depths.get(item.parent) + 1;
        if (depth > MindmeImport.limits.depth) throw new Error("插入后层级过深，本次最多支持 128 层");
        depths.set(item.id, depth);
      }
      importTransaction(() => {
        remember();
        const ids = new Map(parsed.map((item) => [item.id, "paste" + ++serial]));
        const nodes = parsed.map((item) => ({ ...item, id: ids.get(item.id), parent: item.parent === null ? target.id : ids.get(item.parent) }));
        map().nodes.push(...nodes);
        target.collapsed = false;
        selected = ids.get(parsed[0].id);
      });
    } else {
      const roots = parsed.filter((item) => item.parent === null), single = roots.length === 1;
      const rootId = single ? roots[0].id : "synthetic";
      const ids = new Map(parsed.map((item, index) => [item.id, item.id === rootId ? "root" : "outline-" + index]));
      const nodes = parsed.map((item) => ({ ...item, id: ids.get(item.id), parent: item.id === rootId ? null : item.parent === null ? "root" : ids.get(item.parent) }));
      if (!single) nodes.unshift({ id: "root", parent: null, text: "导入的大纲", markers: {} });
      commitImportedMaps([{ nodes }]);
    }
    close();
    toast(target ? "内容已作为子分支插入，原有内容保留" : "已在新标签创建脑图，原有脑图保留");
  } catch (error) {
    importFeedback(`导入失败：${error instanceof Error ? error.message : "内容无法解析"}；原有脑图未改变。`);
  }
}

function restoreVersion(i) {
  const v = clone(snapshots[i]);
  show(
    "restore",
    "恢复历史版本",
    `<p>先将当前内容自动保存为一个新版本，再恢复到「${esc(v.label)}」。其他脑图保持不变。</p><div class="review-choice">最多保留 10 个版本。恢复后的内容将正常同步到其他设备（模拟）。</div><div class="modal-footer"><button id="restore-cancel">取消</button><button class="primary" id="restore-do">保存当前并恢复</button></div>`,
  );
  $("restore-cancel").onclick = close;
  $("restore-do").onclick = () => {
    if (!map()) return;
    if (
      [...maps, ...trash].some((x) => x.id !== current && x.title === v.title)
    ) {
      toast("目标版本名称已被占用；恢复冲突方式仍待评审");
      return;
    }
    const title = v.title;
    snapshots.unshift({
      mapId: current,
      label: "刚刚 · 恢复前",
      note: `自动保留 · ${map().nodes.length} 个节点`,
      nodes: clone(map().nodes),
      title: map().title,
    });
    let kept = 0;
    snapshots = snapshots.filter((x) => x.mapId !== current || ++kept <= 10);
    remember();
    map().nodes = v.nodes;
    map().title = title;
    map().nodes.find((x) => !x.parent).text = title;
    selected = null;
    close();
    changed("已保留恢复前版本，并恢复历史内容");
    toast("已先保存当前内容，再恢复历史版本");
  };
}
function confirmPurge(id) {
  const m = trash.find((x) => x.id === id);
  show(
    "purge",
    "永久删除脑图",
    `<p>永久删除「${esc(m.title)}」？</p><div class="warning">删除后无法恢复。删除完成后，该名称才会释放。</div><div class="modal-footer"><button id="purge-cancel">取消</button><button class="primary" id="purge-do">永久删除</button></div>`,
  );
  $("purge-cancel").onclick = () => dialog("trash");
  $("purge-do").onclick = () => {
    trash = trash.filter((x) => x.id !== id);
    render();
    dialog("trash");
    toast("已永久删除，名称已释放");
  };
}
function download(all) {
  const data = {
    format: "mindme-prototype",
    version: 1,
    scope: all ? "space" : "map",
    maps: clone(all ? maps : [map()]).map((m) => ({
      ...m,
      nodes: m.nodes.map(({ x, y, ...n }) => n),
    })),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    }),
    a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = all ? "mindme-空间备份-草图.json" : "mindme-脑图备份-草图.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 100);
  toast("已下载草图演示 JSON；正式备份格式待技术实现");
}
function importBackup(data) {
  if (
    data?.format !== "mindme-prototype" ||
    data.version !== 1 ||
    !Array.isArray(data.maps) ||
    !data.maps.length
  )
    throw Error("格式错误");
  const incoming = clone(data.maps);
  if (
    !incoming.every(
      (m) =>
        typeof m.title === "string" &&
        Array.isArray(m.nodes) &&
        m.nodes.length &&
        m.nodes.every(
          (n) => typeof n.id === "string" && typeof n.text === "string",
        ) &&
        m.nodes.filter((n) => n.parent === null).length === 1,
    )
  )
    throw Error("节点错误");
  for (const m of incoming) {
    const ids = new Set(m.nodes.map((n) => n.id));
    if (
      ids.size !== m.nodes.length ||
      m.nodes.some((n) => n.parent !== null && !ids.has(n.parent))
    )
      throw Error("引用错误");
    for (const n of m.nodes) {
      const seen = new Set();
      let p = n;
      while (p) {
        if (seen.has(p.id)) throw Error("循环");
        seen.add(p.id);
        p = m.nodes.find((x) => x.id === p.parent);
      }
    }
  }
  incoming.forEach((m) => {
    m.id = "restore" + ++serial;
    m.title = unique(m.title);
    m.nodes.find((n) => n.parent === null).text = m.title;
    m.nodes.forEach((n) => (n.markers = n.markers || {}));
    m.pinned = Boolean(m.pinned);
    m.open = Boolean(m.open);
    maps.push(m);
  });
  close();
  render();
  toast(`已导入 ${incoming.length} 张新副本，原有内容与标签保持不变`);
}
function runScenario() {
  const v = $("scenario").value;
  if (v === "online") {
    mode = "online";
    updateSync();
    if (pending)
      setTimeout(() => {
        pending = 0;
        updateSync();
      }, 700);
    toast("演示：已恢复联网，自动同步待提交修改");
  } else if (v === "offline" || v === "failed") {
    mode = v;
    updateSync();
    toast(
      v === "offline"
        ? "演示：网络已断开，可继续编辑"
        : "演示：同步失败，本地修改保留；点击顶部状态可重试",
    );
  } else if (v === "remote") {
    if (!map()) return;
    map().nodes.push({
      id: "remote" + ++serial,
      parent: "root",
      text: "另一台 Mac 的新想法",
      side: 1,
      markers: {},
    });
    render();
    status("收到另一设备的节点变化（模拟）");
    toast("演示：远端修改已显示，不改变本机选中节点或视角");
  } else {
    show(
      "conflict",
      "有离线修改未应用",
      `<p>另一设备已经删除节点「待确认事项」。该节点不会因这次离线编辑自动恢复。</p><div class="choice-row"><div class="grow"><b>本次离线修改</b><small>补充交互方案的评审意见</small></div></div><div class="review-choice">待评审建议：提供复制离线文字的入口，让你自行决定是否新建节点。</div><div class="modal-footer"><button id="conflict-close">知道了</button><button class="primary" id="conflict-copy">复制离线文字</button></div>`,
    );
    $("conflict-close").onclick = close;
    $("conflict-copy").onclick = async () => {
      try {
        await navigator.clipboard.writeText("补充交互方案的评审意见");
        toast("已复制离线文字（演示）");
      } catch {
        toast("浏览器未允许复制，请选中上面的文字复制");
      }
    };
  }
}
$("files").onclick = (e) => {
  const b = e.target.closest("[data-map]");
  if (b) openMap(b.dataset.map);
};
$("tabs").onclick = (e) => {
  const c = e.target.closest("[data-close]");
  if (c) {
    const m = maps.find((x) => x.id === c.dataset.close);
    m.open = false;
    if (current === m.id) {
      current = maps.find((x) => x.open)?.id || null;
      selected = null;
    }
    render();
    toast("标签已关闭，脑图仍在左侧列表；下次不自动恢复");
    return;
  }
  const b = e.target.closest("[data-tab]");
  if (b) openMap(b.dataset.tab);
  else if (e.target.closest(".addtab")) create();
};
$("tabs").ondragstart = (e) => {
  tabDrag = e.target.closest("[data-tab]")?.dataset.tab;
};
$("tabs").ondragover = (e) => e.preventDefault();
$("tabs").ondrop = (e) => {
  e.preventDefault();
  const to = e.target.closest("[data-tab]")?.dataset.tab;
  if (!to || !tabDrag || to === tabDrag) return;
  const m = maps.splice(
    maps.findIndex((x) => x.id === tabDrag),
    1,
  )[0];
  maps.splice(
    maps.findIndex((x) => x.id === to),
    0,
    m,
  );
  render();
  toast("标签顺序已调整");
};
// 侧栏开关只改变本设备的界面显示，不改动脑图、选择或撤销记录。
for (const [side, label] of [
  ["left", "左侧脑图列表"],
  ["right", "右侧节点面板"],
]) {
  const button = $("toggle-" + side);
  button.onclick = () => {
    const collapsed = document
      .querySelector(".layout")
      .classList.toggle(side + "-collapsed");
    button.setAttribute("aria-expanded", String(!collapsed));
    button.setAttribute("aria-label", (collapsed ? "展开" : "收起") + label);
    button.title = (collapsed ? "展开" : "收起") + label;
    status((collapsed ? "已收起" : "已展开") + label + " · 画布可用空间已调整");
  };
}
$("new").onclick = () => create();
$("add").onclick = () => add();
$("sibling").onclick = () => add(true);
$("fold").onclick = fold;
$("fold-all").onclick = () => foldAll();
$("undo").onclick = undo;
$("redo").onclick = redo;
$("save").onclick = manualSave;
$("shortcuts").onclick = showShortcuts;
$("delete-node").onclick = removeNode;
$("edit-node").onclick = () => editNode();
$("node-label").onchange = (e) => rename(selected, e.target.value);
$("priority-markers").onclick = $("progress-markers").onclick = $("flag-markers").onclick = (e) => {
  const b = e.target.closest("[data-mark]"),
    n = node();
  if (!b || !n) return;
  remember();
  const k = b.dataset.category,
    v = b.dataset.mark;
  if (normalizedMarker(k, n.markers[k]) === v) delete n.markers[k];
  else n.markers[k] = v;
  changed("标记已更新 · 同类替换，异类保留");
};
$("account").onclick = () => dialog("login");
$("more").onclick = () => dialog("more");
$("sync").onclick = () => dialog("sync");
document
  .querySelectorAll("[data-dialog]")
  .forEach((b) => (b.onclick = () => dialog(b.dataset.dialog)));
$("close-dialog").onclick = close;
$("overlay").onclick = (e) => {
  if (e.target === $("overlay")) close();
};
$("dialog-body").onclick = (e) => {
  if (e.target.id === "switch-account") dialog("login");
};
$("zoom-in").onclick = () => changeZoom(0.1);
$("zoom-out").onclick = () => changeZoom(-0.1);
$("fit").onclick = () => {
  zoom = 1;
  panX = 0;
  panY = 0;
  $("zoom-value").textContent = "100%";
  draw();
};
$("run-scenario").onclick = runScenario;
$("review").onclick = () =>
  show(
    "review",
    "这一版看什么",
    `<p>这是一份可点击的编辑器草图，刷新会回到演示数据，不会改动你的真实脑图。</p><div class="choice-row"><div><b>已经确认的操作</b><small>顶部标签切换/排序/固定；空白处左键拖动画布；左右侧栏独立收起/展开；节点编辑/增删；折叠与标记；三种粘贴状态。</small></div></div><div class="choice-row"><div><b>可以点开的状态</b><small>导入、备份、历史恢复、回收站、账号访问，以及右下的离线和冲突场景。</small></div></div><div class="review-choice">待评审：面板的位置；导入异常提示；离线冲突时复制文字找回；布局的左右分配与拖动细节。<br>当前简化布局不代表已经复刻 XMind 8 的全部规则，拖动会在松手后重排。<br>用户选定快捷键已接入，点击工具栏“快捷键”查看；⌘S 仅模拟保存，正式云端和 XMind 8 富剪贴板仍待实现。</div>`,
  );
$("graph").ondblclick = (e) => {
  if (e.target.closest("[data-fold]")) return;
  const g = e.target.closest("[data-node]");
  if (g) {
    selected = g.dataset.node;
    editNode();
  }
};
// 按下时仅记录起点；真正开始移动后才捕获指针，避免把双击重定向到画布。
$("graph").onpointerdown = (e) => {
  if (e.button !== 0) return;
  const f = e.target.closest("[data-fold]");
  if (f) {
    selected = f.dataset.fold;
    fold();
    return;
  }
  const g = e.target.closest("[data-node]");
  if (!g) {
    if (inlineEdit) finishInlineEdit(true);
    selected = null;
    render(false);
    const point = svgPoint(e);
    if (point) {
      e.preventDefault();
      drag = null;
      pan = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        origin: point,
        x: panX,
        y: panY,
        moved: false,
      };
    }
    return;
  }
  selected = g.dataset.node;
  render(false);
  const n = node();
  if (!n?.parent) return;
  drag = {
    id: n.id,
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    x: n.x,
    y: n.y,
    target: null,
    moved: false,
  };
};
$("graph").onpointermove = (e) => {
  if (pan) {
    if (e.pointerId !== pan.pointerId) return;
    const delta =
      Math.abs(e.clientX - pan.startX) + Math.abs(e.clientY - pan.startY);
    if (!pan.moved && delta < 3) return;
    if (!pan.moved) {
      pan.moved = true;
      $("graph").setPointerCapture(e.pointerId);
      $("graph").classList.add("is-panning");
    }
    const point = svgPoint(e);
    if (!point) return;
    panX = pan.x + point.x - pan.origin.x;
    panY = pan.y + point.y - pan.origin.y;
    applyViewport();
    status("拖动空白处 · 整张脑图跟随移动");
    return;
  }
  if (!drag) return;
  const dx = e.clientX - drag.startX,
    dy = e.clientY - drag.startY;
  if (Math.abs(dx) + Math.abs(dy) < 6 && !drag.moved) return;
  if (!drag.moved) {
    drag.moved = true;
    $("graph").setPointerCapture(drag.pointerId);
  }
  const svg = $("graph"),
    r = svg.getBoundingClientRect(),
    factor = Math.min(r.width / 1100, r.height / 650) * zoom,
    x = drag.x + dx / factor,
    y = drag.y + dy / factor;
  const g = svg.querySelector(`[data-node="${drag.id}"]`);
  if (g) {
    g.classList.add("dragging");
    const metrics = nodeMetrics(map().nodes.find((n) => n.id === drag.id));
    g.setAttribute("transform", `translate(${x - metrics.width / 2} ${y - metrics.height / 2})`);
  }
  const forbidden = new Set([drag.id]);
  let before = 0;
  while (before !== forbidden.size) {
    before = forbidden.size;
    map().nodes.forEach((n) => {
      if (forbidden.has(n.parent)) forbidden.add(n.id);
    });
  }
  drag.target =
    visibleNodes().find(
      (n) =>
        !forbidden.has(n.id) &&
        Math.abs(n.x - x) < nodeMetrics(n).width / 2 + 8 &&
        Math.abs(n.y - y) < nodeMetrics(n).height / 2 + 8,
    )?.id || null;
  svg.querySelectorAll(".target").forEach((n) => n.classList.remove("target"));
  if (drag.target) {
    svg.querySelector(`[data-node="${drag.target}"]`)?.classList.add("target");
    status("松手后挂接为该节点的子主题");
  } else status("松手后自动计算节点排布，不改变父子关系");
};
$("graph").onpointerup = (e) => {
  if (stopPan(e)) return;
  if (!drag) return;
  const d = drag;
  drag = null;
  if (!d.moved) return;
  remember();
  const n = map().nodes.find((x) => x.id === d.id),
    dy = e.clientY - d.startY,
    dx = e.clientX - d.startX;
  if (d.target) {
    n.parent = d.target;
    map().nodes.find((x) => x.id === d.target).collapsed = false;
    n.side = undefined;
    toast("已挂接到目标节点，自动布局已更新");
  } else {
    if (n.parent === "root" && Math.abs(dx) > 40)
      n.side = n.x + dx > 550 ? 1 : -1;
    const peers = children(n.parent).filter(
      (x) => x.id !== n.id && x.side === n.side,
    );
    const next = peers.find((x) => (dy < 0 ? x.y < n.y : x.y > n.y));
    if (next) {
      const arr = map().nodes,
        from = arr.indexOf(n);
      arr.splice(from, 1);
      arr.splice(arr.indexOf(next) + (dy > 0 ? 1 : 0), 0, n);
    }
  }
  changed("拖动完成 · 自动重排（布局细节待对照 XMind 8）");
};
$("graph").onpointercancel = (e) => {
  if (stopPan(e)) return;
  drag = null;
  render();
};
$("graph").onlostpointercapture = () => {
  if (pan) {
    pan = null;
    $("graph").classList.remove("is-panning");
  }
};
const shortcutRows = [
  ["Tab", "新增子主题"],
  ["Return", "新增同级主题；编辑文字时保存"],
  ["⌘ Return", "新增父主题"],
  ["Space", "节点内编辑文字"],
  ["Esc", "取消文字编辑"],
  ["Delete", "删除节点及全部子节点"],
  ["⌘ Z", "撤销"],
  ["⇧ ⌘ Z", "重做"],
  ["⌘ C / ⌘ V", "复制 / 粘贴节点分支；编辑时复制 / 粘贴文字"],
  ["⌘ = / ⌘ −", "放大 / 缩小画布"],
  ["⌘ /", "折叠 / 展开当前分支"],
  ["⌥ ⌘ /", "折叠 / 展开选中节点下的全部子分支"],
  ["⌘ S", "手动触发模拟保存"],
  ["⌥ ↑ / ⌥ ↓", "同父节点的同级主题上下排序"],
];
function showShortcuts() {
  show(
    "shortcuts",
    "快捷键",
    `<p>画布操作和节点文字编辑分别处理；输入中文时不误触创建或删除。仅响应你选择的 macOS 组合键。</p><table class="shortcut-table"><tbody>${shortcutRows.map(([key, label]) => `<tr><td><kbd>${esc(key)}</kbd></td><td>${esc(label)}</td></tr>`).join("")}</tbody></table><div class="review-choice">⌘S 只触发草图模拟保存，刷新会重置。复制分支保留节点文字、层级、标记；来自真实 XMind 8 的富格式尚未解析。Alt 就是 Mac 的 Option（⌥）。</div>`,
  );
}
function textInput(target) {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        'input,textarea,select,[contenteditable="true"],[contenteditable=""]',
      ),
    )
  );
}
function editingContext(event) {
  return textInput(event.target) || Boolean(inlineEdit) || !$("overlay").hidden;
}
document.addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (!$("overlay").hidden) {
    if (e.key === "Tab") {
      const items = [
        ...$("overlay").querySelectorAll(
          "button:not(:disabled),input:not(:disabled),textarea,select",
        ),
      ];
      if (items.length) {
        const first = items[0],
          last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    } else if (e.key === "Escape") close();
    return;
  }
  const key = e.key.toLowerCase(),
    command = e.metaKey && !e.ctrlKey;
  if (command && !e.altKey && key === "s") {
    e.preventDefault();
    manualSave();
    return;
  }
  if (editingContext(e)) return;
  if (command) {
    if (!e.altKey && key === "z") {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
      return;
    }
    if ((e.code === "Slash" || key === "/") && !e.shiftKey) {
      e.preventDefault();
      e.altKey ? foldAll() : fold();
      return;
    }
    if (!e.altKey && !e.shiftKey && e.key === "Enter") {
      e.preventDefault();
      addParent();
      return;
    }
    if (!e.altKey && (e.code === "Equal" || key === "=" || key === "+")) {
      e.preventDefault();
      changeZoom(0.1);
      return;
    }
    if (!e.altKey && !e.shiftKey && (e.code === "Minus" || key === "-")) {
      e.preventDefault();
      changeZoom(-0.1);
      return;
    }
    // 复制/粘贴留给系统事件，才能使用浏览器真实剪贴板和原生权限语义。
    return;
  }
  if (
    e.altKey &&
    !e.ctrlKey &&
    !e.shiftKey &&
    (e.key === "ArrowUp" ||
      e.key === "ArrowDown" ||
      e.code === "ArrowUp" ||
      e.code === "ArrowDown")
  ) {
    e.preventDefault();
    moveSibling(e.key === "ArrowUp" || e.code === "ArrowUp" ? -1 : 1);
    return;
  }
  if (e.altKey || e.ctrlKey || e.shiftKey) return;
  if (e.key === "Tab") {
    e.preventDefault();
    add();
  } else if (e.key === "Enter") {
    e.preventDefault();
    add(true);
  } else if (e.code === "Space" || e.key === " ") {
    e.preventDefault();
    editNode();
  } else if (e.key === "Backspace" || e.key === "Delete") {
    e.preventDefault();
    removeNode();
  }
});
document.addEventListener("copy", (e) => {
  if (editingContext(e)) return;
  const payload = exportBranch();
  if (!payload || !e.clipboardData) return;
  e.preventDefault();
  try {
    e.clipboardData.setData("text/plain", branchText(payload));
    e.clipboardData.setData(branchMime, JSON.stringify(payload));
    toast(`已复制 ${payload.nodes.length} 个节点及其标记`);
  } catch {
    toast("浏览器未完成结构复制，请重试或复制文字");
  }
});
document.addEventListener("paste", (e) => {
  if (editingContext(e) || !e.clipboardData) return;
  const custom = e.clipboardData.getData(branchMime),
    text = e.clipboardData.getData("text/plain");
  if (!custom && !text) return;
  e.preventDefault();
  if (custom) {
    try {
      insertBranch(JSON.parse(custom));
    } catch {
      toast("剪贴板结构无法识别，未修改当前脑图");
    }
  } else pasteOutline(text);
});
render();
updateSync();
