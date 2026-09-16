# Mallkit

一套完整的微信小程序电商系统：小程序商城 + Node.js 管理后台，跑在腾讯云 CloudBase 上。

这不是脚手架，是一套在真实生意里跑过的代码。下单、微信支付、多规格 SKU、优惠券、
分销佣金、积分会员、企业礼券、AI 运营助手，全部已经打通并在线上用过。

所有店名、电话、地址、环境 ID 都是占位值，换成你自己的品牌即可上线。

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)
![Platform](https://img.shields.io/badge/platform-%E5%BE%AE%E4%BF%A1%E5%B0%8F%E7%A8%8B%E5%BA%8F%20%2B%20CloudBase-orange.svg)

---

## 界面预览

### 小程序端

| 首页 | 商品详情 | 购物车 | 我的 |
|---|---|---|---|
| ![首页](docs/screenshots/miniprogram-home.png) | ![商品详情](docs/screenshots/miniprogram-detail.png) | ![购物车](docs/screenshots/miniprogram-cart.png) | ![我的](docs/screenshots/miniprogram-my.png) |

| 结算下单 | 订单列表 | 会员中心 | 分销中心 |
|---|---|---|---|
| ![结算](docs/screenshots/miniprogram-checkout.png) | ![订单](docs/screenshots/miniprogram-orders.png) | ![会员](docs/screenshots/miniprogram-member.png) | ![分销](docs/screenshots/miniprogram-distribution.png) |

### 管理后台

![仪表盘](docs/screenshots/admin-dashboard.png)

| 商品管理 | 订单管理 | 数据分析 | AI 助手 |
|---|---|---|---|
| ![商品](docs/screenshots/admin-products.png) | ![订单](docs/screenshots/admin-orders.png) | ![分析](docs/screenshots/admin-analytics.png) | ![助手](docs/screenshots/admin-assistant.png) |

> 上面 13 张目前是灰色占位图。替换方法与脱敏注意事项见
> [docs/screenshots/README.md](docs/screenshots/README.md)，按同名覆盖即可。

---

## 功能清单

### 小程序端（27 个页面）

| 模块 | 说明 |
|---|---|
| 商品浏览 | 首页轮播、分类导航、搜索、及时达专区 |
| 商品详情 | 多规格 SKU、富文本详情、分享海报、长按识别二维码 |
| 购物车与下单 | 多商品结算、地址管理、优惠券抵扣、分区运费 |
| 支付 | 微信支付、超时自动取消、余额充值 |
| 订单 | 状态流转、物流轨迹查询、申请退款、评价晒单 |
| 会员 | 等级体系、积分获取与兑换、每日签到 |
| 分销 | 专属推广码、佣金结算、提现申请 |
| 企业礼券 | 扫码核销、免付货款下单 |

### 管理后台（13 个功能模块）

| 模块 | 说明 |
|---|---|
| 仪表盘 | 今日营收、待办事项、低库存预警 |
| 商品 | 商品与分类管理、多规格配置、轮播图、图片自动压缩 |
| 订单 | 发货与物流上报、退款审核、订单导出 |
| 用户 | 用户列表、积分调整、客户分析 |
| 分销 | 分销员管理、邀请码、佣金比例、提现审核 |
| 营销 | 优惠券、评价管理、积分礼品库 |
| 企业礼券 | 企业账户与充值、券批次生成、二维码批量打包下载 |
| 财务 | 月度报表、CSV 导出 |
| 云存储 | 文件管理、孤儿图扫描、批量重压 |
| AI 助手 | 自然语言查询经营数据，可执行发货等操作 |
| 店铺设置 | 运费规则、自提点、海报文案、服务承诺 |
| 账号安全 | 改密、两步验证 |
| 弹窗 | 首页活动弹窗管理 |

### 云函数（12 个）

订单、支付、支付回调、购物车、用户登录、分销、会员、礼品、弹窗、商品、
礼券核销、超时订单清理。

---

## 环境要求

- 腾讯云 CloudBase 环境，按量计费即可
- 微信小程序账号；要收款还需要微信支付商户号（**个人主体开不了微信支付**）
- Node.js 20 或更高（后台用了 sharp 处理图片，不能降到 18）
- 微信开发者工具

---

## 快速开始

完整步骤见 [docs/01-快速开始.md](docs/01-快速开始.md)，从零到跑通大约半天，
其中大部分时间在等微信和腾讯云审核。

简要流程：

1. 创建 CloudBase 环境，记下环境 ID、存储桶名、所在地域
2. 在 `miniprogram/project.config.json` 填入你的小程序 AppID
3. 部署 12 个云函数，创建 26 个数据库集合
4. 把 `admin/` 部署到云托管，配置[环境变量](docs/05-配置项参考.md)
5. 登录后台填写店铺信息、运费规则、自提点
6. 按[品牌替换清单](docs/04-品牌替换清单.md)改店名、主题色等需要动代码的地方

> 上线前务必重写用户协议和隐私政策，仓库里是通用模板，不能直接当作你的经营条款。

---

## 文档

| 文档 | 内容 |
|---|---|
| [01-快速开始](docs/01-快速开始.md) | 从零部署的完整步骤 |
| [02-部署-管理后台](docs/02-部署-管理后台.md) | 云托管部署与排错 |
| [03-部署-小程序](docs/03-部署-小程序.md) | 云函数部署、域名配置、审核注意事项 |
| [04-品牌替换清单](docs/04-品牌替换清单.md) | 换品牌要改哪些地方，含运费规则 |
| [05-配置项参考](docs/05-配置项参考.md) | 全部环境变量与店铺设置字段 |
| [06-常见问题](docs/06-常见问题.md) | 部署、支付、二次开发的典型问题 |
| [07-可选模块说明](docs/07-可选模块说明.md) | 用不上的功能怎么关 |

---

## 目录结构

```
admin/          管理后台，Express + CloudBase SDK，部署到云托管
miniprogram/    小程序前端与云函数
docs/           部署与二次开发文档
tools/sync/     上游同步工具，见下
```

`admin/` 和 `miniprogram/` 由同步工具从一个私有上游仓库生成。
**直接修改这两个目录的内容会在下次同步时被覆盖。**
想改代码请提 issue 或 pull request，会被合并到上游再同步过来，
详见[贡献指南](CONTRIBUTING.md)。

---

## 许可证

Apache License 2.0。详见 [LICENSE](LICENSE) 与[第三方依赖声明](NOTICE.md)。

可以商用、可以二次开发、可以闭源分发，保留版权声明即可。
