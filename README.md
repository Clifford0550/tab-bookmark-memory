# 📚 Tab Bookmark

> 把浏览器收藏夹和历史记录变成一台时光机。

🍴 Forked from [zarazhangrui/tab-out](https://github.com/zarazhangrui/tab-out) — 在原 Tab Out 基础上加入了完整的「整理收藏夹」+「近期足迹」工作流。

---

## 这是什么

Tab Bookmark 是一个 Chrome 扩展，把你的新标签页变成三件事的入口：

1. **🗂 浏览器标签** — 实时把所有打开的 tab 按域名分组
2. **📚 整理收藏夹** — 重新认识 + 整理你那几百条祖传收藏
3. **👣 近期足迹** — 用 7×24 热力图看你最近真正在花时间的地方

完全本地。无服务器，无外部 API 调用，无账号。

---

## ✨ Features

### 🗂 浏览器标签

打开的 tab 按域名实时分组成卡片，Homepages 单独抽出（Gmail / X / LinkedIn / YouTube / GitHub）。关闭带 swoosh 音效 + 撒花动画。重复 tab 检测、稍后看清单、localhost 端口区分。

### 📚 整理收藏夹

两种模式：**时光机** 把书签按 3 / 6 / 12 个月切成时段卡片，看完点 CTA 就能进入对应时段的整理；**浏览整理** 是横向 lane 视图，支持拖拽分类、多选批量删除/移动、sticky 文件夹导航。自带重复检测、失效检测、空文件夹清理、三档年龄分层（1 / 2 / 3 年+不同视觉强度）。

### 👣 近期足迹

7×24 周热力图直接显示你哪天哪个小时最忙，**点格子下钻**到那个时段的具体页面。配合高频域名 / 高频页面榜单，所有图表都可点过滤，顶部 chip 条显示当前过滤条件。时间窗口 24h / 3d / 7d / 30d / 90d 可切。

---

## 安装

### 方式一：交给 AI Agent

把这个仓库地址扔给 Claude Code / Codex / 类似工具：

```
https://github.com/KarenChuang/tab-bookmark
```

跟它说"install this"，1 分钟搞定。

### 方式二：手动

```bash
git clone https://github.com/KarenChuang/tab-bookmark.git
```

1. 进 `chrome://extensions`
2. 打开右上角 **Developer mode**
3. 点 **Load unpacked**，选 `extension/` 文件夹
4. 第一次会弹「读取并修改你的书签 / 浏览历史」权限请求 — 点 **Enable**

打开新标签页，就能看到。

### 更新

```bash
cd tab-bookmark && git pull
```

然后到 `chrome://extensions` 点扩展卡片右下角的 ↻ 重载。

---

## 权限说明

| 权限 | 用途 |
|---|---|
| `tabs` / `activeTab` | 读取并跳转所有打开的 tab |
| `storage` | 存"稍后看"清单 |
| `bookmarks` | 整理收藏夹的读 / 改 / 移 / 删 |
| `history` | 近期足迹的读取 |

**全部数据本地处理**。这个扩展不连任何服务器、不调任何外部 API、不传输任何数据。源码 100% 公开可审计。

---

## 技术栈

| 是什么 | 怎么做 |
|---|---|
| 扩展 | Chrome Manifest V3 |
| 存储 | `chrome.storage.local` + `chrome.bookmarks.*` |
| 历史 | `chrome.history.search` + `chrome.history.getVisits` |
| 失效检测 | `fetch HEAD/GET (no-cors)` + 6 秒超时 + 16 路并发 |
| 拖拽 | 原生 HTML5 Drag & Drop API |
| Sticky 导航 | `position: sticky` + IntersectionObserver |
| 音效 | Web Audio API（合成，无音频文件） |
| 动画 | CSS transitions + JS confetti particles |

---

## License

MIT — 见 [LICENSE](./LICENSE)

- 原项目版权：MIT © 2026 Zara Zhang
- 本 fork 新增功能版权：MIT © 2026 饼饼几 / Karen Chuang

按 MIT 你可以自由使用、修改、再分发，请保留原作者的版权声明。

---

## 致谢

原始项目 [Tab Out by Zara](https://github.com/zarazhangrui/tab-out) 提供了完整的浏览器标签页面板和优雅的暖色基底。

---

Built by [饼饼几](https://www.xiaohongshu.com/user/profile/654a536a000000000400a77e) on top of [Tab Out](https://github.com/zarazhangrui/tab-out).
