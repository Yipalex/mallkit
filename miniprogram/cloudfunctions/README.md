# 云函数说明

本目录下每个子目录是一个微信云开发云函数，需要在微信开发者工具里逐个「上传并部署」。

## 函数一览

| 函数 | 职责 |
| --- | --- |
| `user` | 用户注册/登录态、资料读写、积分 |
| `product` | 商品与分类查询、店铺设置、详情图处理 |
| `cart` | 购物车增删改查 |
| `order` | 下单、运费计算、订单状态流转、发货与物流 |
| `orderTimeout` | 定时触发：待支付订单超时自动取消并回滚库存 |
| `pay` | 微信支付 JSAPI 下单、余额充值下单 |
| `payNotify` | 支付回调：改单、扣库存、发积分、算佣金、群推送 |
| `member` | 会员等级与权益 |
| `distribution` | 分销员、邀请关系、佣金与提现 |
| `gift` | 礼品库与兑换 |
| `popup` | 首页弹窗公告 |
| `voucher` | 企业礼券扫码校验与免付货款下单 |
| `utils` | 公共工具（缓存、限流、错误处理），被其他函数复制引用 |

## 环境变量

完整清单与取值来源见仓库根目录的 `.env.example`。速览：

| 变量 | 使用方 | 说明 |
| --- | --- | --- |
| `WX_APPSECRET` | `order` | 小程序 AppSecret，用于换 access_token |
| `WX_MCH_ID` | `pay` | 微信支付商户号 |
| `WX_API_V3_KEY` | `pay`、`payNotify` | APIv3 密钥，两处必须一致 |
| `WX_MCH_SERIAL_NO` | `pay` | 商户 API 证书序列号 |
| `WX_MCH_PRIVATE_KEY` | `pay` | 商户 API 私钥（PEM 全文） |
| `WX_PAY_PUBLIC_KEY_ID` | `pay` | 微信支付公钥 ID，用于验签 |
| `WEWORK_WEBHOOK_URL` | `payNotify` | 企业微信群机器人地址，可选 |

环境变量在「云开发控制台 → 云函数 → 选中函数 → 配置 → 环境变量」里配置，
改完需要重新部署该函数才生效。

## 部署前必须改的硬编码常量

环境变量之外，还有几处写死在代码里的值：

- `cloudfunctions/order/index.js` 的 `WX_APPID`
- `cloudfunctions/pay/index.js` 的 `APPID` 与两处 `notify_url`
- `cloudfunctions/pay/index.js` 里进微信账单的支付描述文案
- `cloudfunctions/product/index.js` 的 `STORAGE_CDN_DOMAIN`

`notify_url` 的域名是你自己云开发环境的默认访问域名，在云开发控制台
「环境 → 访问服务」里可以查到。
