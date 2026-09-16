// pages/review/add.js - 商品评价页面

Page({
  data: {
    productId: '',
    orderId: '',
    productName: '',
    product: null,
    rating: 0,
    content: '',
    images: [],
    ratingTexts: ['非常差', '差', '一般', '好', '非常好'],
    isLoading: false
  },

  onLoad(options) {
    const { productId, orderId, productName } = options;
    this.setData({
      productId,
      orderId: orderId || '',
      productName: decodeURIComponent(productName || '')
    });
    this.loadProduct();
  },

  // 加载商品信息
  async loadProduct() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'product',
        data: { action: 'getDetail', productId: this.data.productId }
      });
      if (res.result.code === 200) {
        this.setData({ product: res.result.data });
      }
    } catch (err) {
      console.error('加载商品失败', err);
    }
  },

  // 选择评分
  onSelectStar(e) {
    const star = parseInt(e.currentTarget.dataset.star);
    this.setData({ rating: star });
  },

  // 输入评价内容
  onContentInput(e) {
    this.setData({ content: e.detail.value });
  },

  // 添加图片
  onAddImage() {
    const maxCount = 9;
    const currentCount = this.data.images.length;

    if (currentCount >= maxCount) {
      wx.showToast({
        title: '最多上传9张图片',
        icon: 'none'
      });
      return;
    }

    const remainCount = maxCount - currentCount;

    wx.chooseImage({
      count: remainCount,
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const tempFilePaths = res.tempFilePaths;
        this.setData({
          images: [...this.data.images, ...tempFilePaths]
        });
      }
    });
  },

  // 删除图片
  onRemoveImage(e) {
    const index = parseInt(e.currentTarget.dataset.index);
    const images = [...this.data.images];
    images.splice(index, 1);
    this.setData({ images });
  },

  // 提交评价
  async onSubmit() {
    const { productId, rating, content, images } = this.data;

    if (!rating) {
      wx.showToast({
        title: '请评分',
        icon: 'none'
      });
      return;
    }

    if (!content.trim()) {
      wx.showToast({
        title: '请填写评价内容',
        icon: 'none'
      });
      return;
    }

    if (this.data.isLoading) return;

    this.setData({ isLoading: true });

    try {
      // 上传图片到云存储
      const cloudImages = [];
      for (let i = 0; i < images.length; i++) {
        const filePath = images[i];
        try {
          const uploadRes = await wx.cloud.uploadFile({
            cloudPath: `reviews/${Date.now()}_${i}.jpg`,
            filePath: filePath
          });
          cloudImages.push(uploadRes.fileID);
        } catch (err) {
          console.error('上传图片失败', err);
        }
      }

      // 提交评价到云函数
      const res = await wx.cloud.callFunction({
        name: 'product',
        data: {
          action: 'submitReview',
          productId,
          orderId: this.data.orderId,
          rating,
          content,
          images: cloudImages
        }
      });

      if (res.result.code === 200) {
        wx.showToast({
          title: '评价成功',
          icon: 'success',
          duration: 2000
        });

        setTimeout(() => {
          wx.navigateBack();
        }, 2000);
      } else {
        wx.showToast({
          title: res.result.message || '评价失败',
          icon: 'none'
        });
      }
    } catch (err) {
      console.error('提交评价失败', err);
      wx.showToast({
        title: '评价失败，请重试',
        icon: 'none'
      });
    } finally {
      this.setData({ isLoading: false });
    }
  }
});
