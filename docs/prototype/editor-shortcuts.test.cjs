// 验证草图的领域行为与按键分发；真实剪贴板/输入焦点仍由浏览器回归检查。
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function fixture() {
  const listeners = new Map();
  class FakeElement {
    constructor() {
      this.hidden = true;
      this.value = "";
    }
    closest() {
      return null;
    }
    querySelectorAll() {
      return [];
    }
    setAttribute() {}
    addEventListener() {}
  }
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new FakeElement());
    return elements.get(id);
  };
  const context = vm.createContext({
    console,
    Element: FakeElement,
    setTimeout: () => 1,
    clearTimeout: () => {},
    document: {
      getElementById: element,
      querySelectorAll: () => [],
      addEventListener: (name, handler) => listeners.set(name, handler),
    },
  });
  const source = fs
    .readFileSync(path.join(__dirname, "editor.js"), "utf8")
    .replace(/render\(\);\s*updateSync\(\);\s*$/, "");
  vm.runInContext(fs.readFileSync(path.join(__dirname, "importer.js"), "utf8"), context);
  vm.runInContext(source, context);
  vm.runInContext(
    "renderActual=render;drawActual=draw;render=()=>{};draw=()=>{};applyViewport=()=>{};svgPoint=e=>({x:e.clientX,y:e.clientY});updateSync=()=>{};close=()=>{};layout();",
    context,
  );
  return {
    run: (code) => vm.runInContext(code, context),
    state: (code) =>
      JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context)),
    press(key, options = {}) {
      const event = {
        key,
        code: key,
        target: new FakeElement(),
        metaKey: false,
        altKey: false,
        shiftKey: false,
        ctrlKey: false,
        isComposing: false,
        preventDefault() {
          this.prevented = true;
        },
        ...options,
      };
      listeners.get("keydown")(event);
      return event;
    },
  };
}

test("Tab、Return、⌘Return 分别新增子、同级、父主题，原分支不丢失", () => {
  const app = fixture();
  app.run("selected='a'");
  app.press("Tab");
  const child = app.state("node()");
  assert.equal(child.parent, "a");
  app.press("Enter");
  const sibling = app.state("node()");
  assert.equal(sibling.parent, "a");
  app.press("Enter", { metaKey: true });
  const parent = app.state("node()");
  assert.equal(parent.parent, "a");
  assert.equal(
    app.state(
      `map().nodes.find(n=>n.id===${JSON.stringify(sibling.id)}).parent`,
    ),
    parent.id,
  );
  assert.equal(app.state("map().nodes.length"), 16);
});

test("Option 上下调整同级顺序，中心/边界操作不新增历史", () => {
  const app = fixture();
  app.run("selected='a1'");
  app.press("ArrowDown", { altKey: true });
  assert.deepEqual(app.state("children('a').map(n=>n.id)"), ["a2", "a1"]);
  assert.equal(app.state("node().parent"), "a");
  app.press("ArrowUp", { altKey: true });
  assert.deepEqual(app.state("children('a').map(n=>n.id)"), ["a1", "a2"]);
  const history = app.state("undoStack.length");
  app.press("ArrowUp", { altKey: true });
  assert.equal(app.state("undoStack.length"), history);
  app.run("selected='root'");
  app.press("Enter");
  app.press("Enter", { metaKey: true });
  app.press("Delete");
  assert.equal(app.state("map().nodes.length"), 13);
});

test("删除/撤销/重做保留整个子树，标签和视角不回滚，新修改清当前图重做", () => {
  const app = fixture();
  app.run("selected='a'");
  app.press("Delete");
  assert.equal(app.state("map().nodes.length"), 10);
  app.run("map().pinned=false;panX=90;zoom=1.4");
  app.press("z", { metaKey: true });
  assert.equal(app.state("map().nodes.length"), 13);
  assert.equal(app.state("map().pinned"), false);
  assert.equal(app.state("panX"), 90);
  app.press("z", { metaKey: true, shiftKey: true });
  assert.equal(app.state("map().nodes.length"), 10);
  app.press("z", { metaKey: true });
  app.run("selected='b'");
  app.press("Tab");
  assert.equal(app.state("redoStack.filter(x=>x.id===current).length"), 0);
});

test("各图撤销/重做独立，新建其他脑图不清除已有图历史", () => {
  const app = fixture();
  app.run("selected='a'");
  app.press("Tab");
  app.press("z", { metaKey: true });
  app.run("create('新图')");
  app.press("Tab");
  app.run("openMap('launch')");
  app.press("z", { metaKey: true, shiftKey: true });
  assert.equal(app.state("map().nodes.length"), 14);
  app.press("z", { metaKey: true });
  assert.equal(app.state("map().nodes.length"), 13);
});

test("撤销本地改字不删除模拟远端新节点，同字段被远端改过则拒绝回滚", () => {
  const app = fixture();
  app.run(
    "rename('a1','本地文字');map().nodes.push({id:'remote',parent:'root',text:'远端新节点',markers:{}})",
  );
  app.press("z", { metaKey: true });
  assert.equal(app.state("map().nodes.find(n=>n.id==='a1').text"), "用户访谈");
  assert.equal(
    app.state("map().nodes.find(n=>n.id==='remote').text"),
    "远端新节点",
  );
  app.press("z", { metaKey: true, shiftKey: true });
  app.run("map().nodes.find(n=>n.id==='a1').text='远端新文字'");
  app.press("z", { metaKey: true });
  assert.equal(
    app.state("map().nodes.find(n=>n.id==='a1').text"),
    "远端新文字",
  );
});

test("当前与全部折叠切换可撤销，缩放只改视角", () => {
  const app = fixture();
  app.run("selected='a'");
  app.press("/", { code: "Slash", metaKey: true });
  assert.equal(app.state("visibleNodes().length"), 11);
  app.press("/", { code: "Slash", metaKey: true });
  assert.equal(app.state("visibleNodes().length"), 13);
  app.press("/", { code: "Slash", metaKey: true, altKey: true });
  assert.equal(app.state("visibleNodes().length"), 11);
  app.press("/", { code: "Slash", metaKey: true, altKey: true });
  assert.equal(app.state("visibleNodes().length"), 13);
  const count = app.state("undoStack.length");
  app.press("=", { code: "Equal", metaKey: true });
  assert.equal(app.state("zoom"), 1.1);
  app.press("-", { code: "Minus", metaKey: true });
  assert.equal(app.state("zoom"), 1);
  assert.equal(app.state("undoStack.length"), count);
});

test("分支剪贴板保留层级与标记，重复粘贴生成新 ID，非法循环不写入", () => {
  const app = fixture();
  app.run(
    "selected='a';copied=exportBranch();selected='b';insertBranch(copied);selected='b';insertBranch(copied)",
  );
  assert.equal(app.state("map().nodes.length"), 19);
  const copies = app.state("children('b').filter(n=>n.text==='发现与定义')");
  assert.equal(copies.length, 2);
  assert.notEqual(copies[0].id, copies[1].id);
  assert.deepEqual(copies[0].markers, { priority: "①" });
  assert.equal(
    app.state(`children(${JSON.stringify(copies[0].id)}).length`),
    2,
  );
  app.run("copied.nodes[1].parent=copied.nodes[1].id;insertBranch(copied)");
  assert.equal(app.state("map().nodes.length"), 19);
});

test("未选中时粘贴新建完整树、外部 Markdown 单根不重复建中心主题", () => {
  const app = fixture();
  app.run(
    "selected='a';copied=exportBranch();selected=null;insertBranch(copied)",
  );
  assert.equal(app.state("map().nodes.length"), 3);
  assert.equal(app.state("map().nodes.filter(n=>n.parent===null).length"), 1);
  app.run("selected=null;pasteOutline('# 测试大纲\\n## 子节点')");
  assert.equal(app.state("map().title"), "测试大纲");
  assert.equal(app.state("map().nodes.length"), 2);
  assert.equal(app.state("map().nodes[1].parent"), "root");
});

test("输入或中文组合期间不执行画布命令，离线 ⌘S 不谎报云端已同步", () => {
  const app = fixture();
  app.run("inlineEdit={id:'a',mapId:current}");
  app.press("Enter");
  app.press("Delete");
  app.run("inlineEdit=null");
  app.press("Tab", { isComposing: true });
  assert.equal(app.state("map().nodes.length"), 13);
  app.run("mode='offline';pending=4");
  app.press("s", { metaKey: true });
  assert.equal(app.state("pending"), 4);
  assert.equal(app.state("mode"), "offline");
});

test("一级主题跨侧排序实际改变布局，父子关系和整条分支保持，连续移动可撤销重做", () => {
  const app = fixture();
  app.run("selected='b';layout()");
  app.press("ArrowDown", { altKey: true });
  app.run("layout()");
  assert.deepEqual(app.state("children('root').map(n=>n.id)"), [
    "a",
    "c",
    "b",
    "d",
  ]);
  assert.equal(app.state("node().side"), -1);
  assert.equal(app.state("node().x"), 305);
  assert.equal(app.state("node().parent"), "root");
  assert.deepEqual(app.state("children('b').map(n=>n.id)"), ["b1", "b2"]);
  assert.equal(app.state("map().nodes.find(n=>n.id==='b1').side"), -1);
  app.press("ArrowDown", { altKey: true });
  app.run("layout()");
  assert.deepEqual(app.state("children('root').map(n=>n.id)"), [
    "a",
    "c",
    "d",
    "b",
  ]);
  app.press("z", { metaKey: true });
  app.press("z", { metaKey: true });
  app.run("layout()");
  assert.deepEqual(app.state("children('root').map(n=>n.id)"), [
    "a",
    "b",
    "c",
    "d",
  ]);
  assert.equal(app.state("map().nodes.find(n=>n.id==='b').side"), 1);
  app.press("z", { metaKey: true, shiftKey: true });
  app.run("layout()");
  assert.deepEqual(app.state("children('root').map(n=>n.id)"), [
    "a",
    "c",
    "b",
    "d",
  ]);
});

test("Option 方向键兼容 code 与 key 表示差异，真正首尾才阻止移动", () => {
  const app = fixture();
  app.run("selected='c'");
  app.press("Up", { code: "ArrowUp", altKey: true });
  assert.deepEqual(app.state("children('root').map(n=>n.id)"), [
    "a",
    "c",
    "b",
    "d",
  ]);
  app.run("selected='a'");
  const before = app.state("undoStack.length");
  app.press("ArrowUp", { altKey: true });
  assert.equal(app.state("undoStack.length"), before);
  app.run("selected='d'");
  app.press("ArrowDown", { altKey: true });
  assert.equal(app.state("undoStack.length"), before);
});

test("滚轮按鼠标锚点缩放，平移后锚点仍稳定，不改内容/历史/同步队列", () => {
  const app = fixture();
  app.run(
    "panX=80;panY=-40;wheel={clientX:740,clientY:220,deltaY:-100,deltaMode:0,target:null,preventDefault(){},stopPropagation(){}}",
  );
  const before = app.state(
    "({x:(740-panX-550+550*zoom)/zoom,y:(220-panY-325+325*zoom)/zoom,content:contentState(),pending,history:undoStack.length})",
  );
  app.run("zoomCanvasOnWheel(wheel)");
  const after = app.state(
    "({x:(740-panX-550+550*zoom)/zoom,y:(220-panY-325+325*zoom)/zoom,content:contentState(),pending,history:undoStack.length,zoom})",
  );
  assert.ok(after.zoom > 1);
  assert.ok(
    Math.abs(before.x - after.x) < 1e-8 && Math.abs(before.y - after.y) < 1e-8,
  );
  assert.deepEqual(after.content, before.content);
  assert.equal(after.pending, before.pending);
  assert.equal(after.history, before.history);
  app.run("wheel.deltaY=100;zoomCanvasOnWheel(wheel)");
  assert.ok(Math.abs(app.state("zoom") - 1) < 0.001);
});

test("滚轮上下限、行单位、零/无效输入，以及文字编辑/弹窗内滚动隔离", () => {
  const app = fixture();
  app.run(
    "wheel={clientX:550,clientY:325,deltaY:-100,deltaMode:0,target:null,preventDefault(){},stopPropagation(){}};for(let i=0;i<50;i++)zoomCanvasOnWheel(wheel)",
  );
  assert.equal(app.state("zoom"), 1.6);
  app.run("wheel.deltaY=100;for(let i=0;i<50;i++)zoomCanvasOnWheel(wheel)");
  assert.equal(app.state("zoom"), 0.4);
  app.run("zoom=1;wheel.deltaY=-3;wheel.deltaMode=1;zoomCanvasOnWheel(wheel)");
  assert.ok(app.state("zoom") > 1);
  const before = app.state("zoom");
  app.run(
    'wheel.deltaY=0;zoomCanvasOnWheel(wheel);wheel.deltaY=NaN;zoomCanvasOnWheel(wheel);wheel.deltaY=-100;$("overlay").hidden=false;zoomCanvasOnWheel(wheel);$("overlay").hidden=true;wheel.target=new Element();wheel.target.closest=()=>({});zoomCanvasOnWheel(wheel)',
  );
  assert.equal(app.state("zoom"), before);
});

test("顶部全部折叠/展开合并为状态切换按钮，只影响选中子树，混合状态优先展开", () => {
  const app = fixture();
  app.run("selected='a';renderActual(false)");
  assert.equal(app.state("$('fold-all').disabled"), false);
  assert.equal(app.state("$('fold-all').textContent"), "全部折叠");
  const others = app.state("map().nodes.filter(n=>!['a','a1','a2'].includes(n.id))");
  app.run("$('fold-all').onclick();renderActual(false)");
  assert.equal(app.state("visibleNodes().length"), 11);
  assert.equal(app.state("selected"), "a");
  assert.deepEqual(app.state("map().nodes.filter(n=>!['a','a1','a2'].includes(n.id))"), others);
  assert.equal(app.state("$('fold-all').textContent"), "全部展开");
  const history = app.state("undoStack.length");
  app.run("foldAll(true)");
  assert.equal(app.state("undoStack.length"), history);
  app.run("$('fold-all').onclick();renderActual(false)");
  assert.equal(app.state("visibleNodes().length"), 13);
  assert.equal(app.state("$('fold-all').textContent"), "全部折叠");
  app.run("map().nodes.push({id:'deep',parent:'a1',text:'孙主题',markers:{}});map().nodes.find(n=>n.id==='a1').collapsed=true;map().nodes.find(n=>n.id==='b').collapsed=true;renderActual(false)");
  assert.equal(app.state("$('fold-all').textContent"), "全部展开");
  app.run("$('fold-all').onclick();renderActual(false)");
  assert.equal(app.state("visibleNodes().some(n=>n.id==='deep')"), true);
  assert.equal(app.state("map().nodes.find(n=>n.id==='b').collapsed"), true);
  assert.equal(app.state("$('fold-all').textContent"), "全部折叠");
  app.run("undo();renderActual(false)");
  assert.equal(app.state("$('fold-all').textContent"), "全部展开");
  app.run("redo();renderActual(false)");
  assert.equal(app.state("$('fold-all').textContent"), "全部折叠");
  app.run("selected='b';renderActual(false)");
  assert.equal(app.state("$('fold-all').textContent"), "全部展开");
  app.run("selected='a2';renderActual(false)");
  assert.equal(app.state("$('fold-all').disabled"), true);
  app.run("selected=null;renderActual(false)");
  const before = app.state("({maps,undo:undoStack.length})");
  app.run("$('fold-all').onclick()");
  assert.deepEqual(app.state("({maps,undo:undoStack.length})"), before);
  assert.equal(app.state("$('fold-all').disabled"), true);
  app.run("current=null;renderActual(false)");
  assert.equal(app.state("$('fold-all').disabled"), true);
});

test("全部折叠后节点加号逐级展开，普通折叠保留后代状态，顶部才展开全部", () => {
  const app = fixture();
  app.run(`map().nodes.push({id:'deep',parent:'a1',text:'孙主题',markers:{}},{id:'deeper',parent:'deep',text:'更深主题',markers:{}});
    selected='a';map().nodes.find(n=>n.id==='b').collapsed=true;foldAll(true);`);
  const collapsed = app.state("map().nodes.map(n=>({id:n.id,collapsed:!!n.collapsed}))");
  const clickFold = (id) => app.run(`$('graph').onpointerdown({button:0,target:{closest:selector=>selector==='[data-fold]'?{dataset:{fold:'${id}'}}:null}})`);
  clickFold('a');
  assert.equal(app.state("visibleNodes().some(n=>n.id==='a1')"), true);
  assert.equal(app.state("visibleNodes().some(n=>n.id==='deep')"), false);
  assert.deepEqual(app.state("foldingBranches(node()).map(n=>!!n.collapsed)"), [false, true, true]);
  assert.equal(app.state("map().nodes.find(n=>n.id==='b').collapsed"), true);
  app.run("undo()");
  assert.deepEqual(app.state("map().nodes.map(n=>({id:n.id,collapsed:!!n.collapsed}))"), collapsed);
  app.run("redo();renderActual(false)");
  assert.equal(app.state("$('fold-all').textContent"), "全部展开");
  clickFold('a1');
  assert.equal(app.state("visibleNodes().some(n=>n.id==='deep')"), true);
  assert.equal(app.state("visibleNodes().some(n=>n.id==='deeper')"), false);
  // 当前层快捷键与工具栏行为一致，不改变孙主题状态。
  app.run("selected='a'");
  app.press('/', { code: 'Slash', metaKey: true });
  app.press('/', { code: 'Slash', metaKey: true });
  assert.equal(app.state("map().nodes.find(n=>n.id==='a1').collapsed"), false);
  assert.equal(app.state("map().nodes.find(n=>n.id==='deep').collapsed"), true);
  app.run("$('fold-all').onclick()");
  assert.equal(app.state("visibleNodes().some(n=>n.id==='deeper')"), true);
  assert.equal(app.state("foldingBranches(node()).every(n=>!n.collapsed)"), true);
  assert.equal(app.state("map().nodes.find(n=>n.id==='b').collapsed"), true);
});

test("选中中心主题时展开全部后代，其他脑图内容及视角保持", () => {
  const app = fixture();
  app.run("map().nodes.push({id:'deep',parent:'a1',text:'孙主题',markers:{}});map().nodes.find(n=>n.id==='a1').collapsed=true;panX=70;panY=-20;zoom=1.2");
  const other = app.state("maps.find(m=>m.id==='learning')");
  app.run("foldAll(true);foldAll(false);layout()");
  assert.equal(app.state("visibleNodes().length"), 14);
  assert.equal(app.state("foldingBranches(map().nodes[0]).every(n=>!n.collapsed)"), true);
  assert.deepEqual(app.state("maps.find(m=>m.id==='learning')"), other);
  assert.deepEqual(app.state("({panX,panY,zoom})"), { panX: 70, panY: -20, zoom: 1.2 });
});

test("长中文、英文与组合表情自动换行，原文字完整保留且每行满足可用宽度", () => {
  const app = fixture();
  const samples = ["这是需要完整显示并自动换行的中文节点内容".repeat(5), "VeryLongUnbrokenEnglishIdentifier".repeat(5), "中文 English 👨‍👩‍👧‍👦 é 全部保留".repeat(4)];
  for (const sample of samples) {
    app.run(`map().nodes.find(n=>n.id==='a').text=${JSON.stringify(sample)}`);
    const metrics = app.state("nodeMetrics(map().nodes.find(n=>n.id==='a'))");
    assert.equal(metrics.lines.join(""), sample);
    assert.ok(metrics.lines.length > 1);
    assert.ok(metrics.height >= metrics.lines.length * metrics.lineHeight + 16);
    assert.equal(app.state("nodeMetrics(map().nodes.find(n=>n.id==='a')).lines.every(line=>measureNodeText(line,12,false)<=nodeMetrics(map().nodes.find(n=>n.id==='a')).textWidth)"), true);
    assert.ok(!metrics.lines.some(line => line.includes("…")));
  }
  app.run("map().nodes.find(n=>n.id==='a').text='第一行\\n\\n第三行'");
  assert.deepEqual(app.state("nodeMetrics(map().nodes.find(n=>n.id==='a')).lines"), ["第一行", "", "第三行"]);
});

test("节点尺寸变化后的布局无重叠，左右列留白且不产生编辑历史", () => {
  const app = fixture();
  app.run("map().nodes.forEach((n,i)=>{n.text=(i%2?'左侧图标与长节点内容':'完整显示的长内容').repeat(8);n.markers={priority:'①',progress:'done',flag:'blue'}})");
  const before = app.state("({undo:undoStack.length,pending})");
  app.run("layout()");
  const bounds = app.state("visibleNodes().map(n=>({id:n.id,x:n.x,y:n.y,...nodeMetrics(n)}))");
  for (let i = 0; i < bounds.length; i++) for (let j = i + 1; j < bounds.length; j++) {
    const a = bounds[i], b = bounds[j];
    const overlapX = Math.abs(a.x - b.x) < (a.width + b.width) / 2;
    const overlapY = Math.abs(a.y - b.y) < (a.height + b.height) / 2;
    assert.ok(!(overlapX && overlapY), `${a.id} 与 ${b.id} 不应重叠`);
  }
  assert.deepEqual(app.state("({undo:undoStack.length,pending})"), before);
  for (const item of bounds) assert.ok(item.textLeft > 8 + 2 * 19 + 16);
});

test("实际 SVG 输出全部换行文本与转义内容，连线端点及编辑区适配节点尺寸", () => {
  const { DOMParser } = require("@xmldom/xmldom");
  const app = fixture();
  app.run("selected='a';node().text=('完整显示 <标签> & English 😀 ').repeat(7);node().markers={progress:'done',flag:'purple'};drawActual()");
  const output = app.run("$('graph').innerHTML");
  const doc = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${output}</svg>`, "application/xml");
  const group = Array.from(doc.getElementsByTagName("g")).find(g => g.getAttribute("data-node") === "a");
  const text = Array.from(group.getElementsByTagName("text")).find(t => t.getAttribute("class") === "node-label");
  assert.equal(text.textContent, app.state("nodeMetrics(node()).lines.join('')"));
  assert.ok(Array.from(text.getElementsByTagName("tspan")).length > 1);
  assert.ok(output.includes("&lt;标签&gt;"));
  assert.ok(!output.includes("…"));
  const endpoint = app.state("({start:map().nodes[0].x+nodeMetrics(map().nodes[0]).width/2,end:node().x-nodeMetrics(node()).width/2})");
  assert.ok(output.includes(`M ${endpoint.start} 325 C`));
  assert.ok(output.includes(`, ${endpoint.end} ${app.state('node().y')}`));
  app.run("inlineEdit={id:'a',mapId:current};drawActual()");
  assert.ok(app.run("$('graph').innerHTML").includes(`height="${app.state('nodeMetrics(node()).height-12')}"`));
});

test("长节点拖动按真实尺寸定位，挂接命中范围覆盖整个目标节点", () => {
  const app = fixture();
  app.run(`selected='a';node().text='拖动的大节点内容'.repeat(20);map().nodes.find(n=>n.id==='b').text='挂接目标'.repeat(20);layout();
    const original=node(), target=map().nodes.find(n=>n.id==='b');
    drag={id:'a',pointerId:1,startX:0,startY:0,x:original.x,y:original.y,target:null,moved:false};
    dragTransform='';
    $('graph').getBoundingClientRect=()=>({width:1100,height:650});
    $('graph').setPointerCapture=()=>{};
    $('graph').querySelector=()=>({classList:{add(){}},setAttribute:(_key,value)=>{dragTransform=value}});
    $('graph').querySelectorAll=()=>[];
    $('graph').onpointermove({clientX:target.x-original.x,clientY:target.y-original.y+nodeMetrics(target).height/2-2});`);
  assert.equal(app.state("drag.target"), "b");
  const expected = app.state("`translate(${drag.x+(map().nodes.find(n=>n.id==='b').x-node().x)-nodeMetrics(node()).width/2} ${map().nodes.find(n=>n.id==='b').y+nodeMetrics(map().nodes.find(n=>n.id==='b')).height/2-2-nodeMetrics(node()).height/2})`");
  assert.equal(app.run("dragTransform"), expected);
});
