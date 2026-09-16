Component({
  properties: {
    // 距底部距离，留作按页微调（如商品页要避让更高的操作栏时传入）。
    // 为空则用 wxss 默认值 calc(140rpx + 安全区)。
    bottom: {
      type: String,
      value: ''
    }
  }
});
