export const SITE_SETTINGS_DEFAULTS = {
  siteTitle: '橙吱_sweety的钢板批发小店',
  navbarBrandMode: 'icon-text',
  navbarBrandText: '橙吱_sweety',
  navbarLogoUrl: '/branding/chengzhi-sweety-logo.png',
  faviconUrl: '/favicon.ico',
  creatorDisplayName: '橙吱_sweety',
  bilibiliUid: '24856973',
  homeTitle: '欢迎各位霸总来到橙吱钢板批发小店',
  homeSubtitle: '养成系全职歌势~',
  playlistCardTitle: '网页歌单',
  playlistCardDescription: '浏览曲目、标签与演唱信息。',
  marshmallowCardTitle: '棉花糖',
  marshmallowCardDescription: '匿名送达想说的话，登录后还能查看回复。',
  prizeCardTitle: '积分商城',
  prizeCardDescription: '使用社区积分兑换限定奖品。',
  playlistTitle: '橙吱_sweety的歌单',
  playlistSubtitle: '想听什么，就从这里开始。',
  marshmallowTitle: '棉花糖',
  marshmallowSubtitle: '写下一封匿名来信。',
  icpText: '',
  publicSecurityText: '',
  primaryColor: '#C04D00',
  lightColor: '#FF8A00',
  darkColor: '#803200',
  backgroundColor: '#FFF8EF',
  backgroundAccentColor: '#FFE0B2',
  textDarkColor: '#362217',
  textLightColor: '#6E5747',
  borderSoftColor: '#F0BF83',
  surfaceSubtleColor: '#ffffff',
  surfaceMutedColor: '#FFF0DA',
  successColor: '#2E7D57',
  warningColor: '#9A5700',
  dangerColor: '#C43D4D',
};

const createThemePreset = (preset) => ({
  ...preset,
  swatches: preset.swatches || [
    preset.values.darkColor,
    preset.values.primaryColor,
    preset.values.lightColor,
    preset.values.backgroundAccentColor,
    preset.values.backgroundColor
  ]
});

export const SITE_THEME_COLOR_SECTIONS = [
  {
    title: '主题主色',
    description: '控制网站主要品牌氛围、背景渐变和视觉主轴。',
    fields: [
      { name: 'primaryColor', label: '主色' },
      { name: 'lightColor', label: '浅色' },
      { name: 'darkColor', label: '深色强调' },
      { name: 'backgroundColor', label: '背景浅色' },
      { name: 'backgroundAccentColor', label: '背景渐变辅色' }
    ]
  },
  {
    title: '界面基础色',
    description: '控制文本、边框和卡片表面层的层次感。',
    fields: [
      { name: 'textDarkColor', label: '主文本色' },
      { name: 'textLightColor', label: '次级文本色' },
      { name: 'borderSoftColor', label: '柔和边框色' },
      { name: 'surfaceSubtleColor', label: '浅表面色' },
      { name: 'surfaceMutedColor', label: '弱表面色' }
    ]
  },
  {
    title: '状态色',
    description: '统一成功、警告和危险状态的按钮、提示与标记色。',
    fields: [
      { name: 'successColor', label: '成功色' },
      { name: 'warningColor', label: '警告色' },
      { name: 'dangerColor', label: '危险色' }
    ]
  }
];

export const SITE_THEME_PRESETS = [
  createThemePreset({
    key: 'anna-classic',
    name: '原站经典',
    description: '取自原 anna_site 的紫色主轴与浅紫渐变，完整还原最初的网站气质。',
    values: {
      primaryColor: '#9b59b6',
      lightColor: '#b19cd9',
      darkColor: '#7d3c98',
      backgroundColor: '#f5f7fa',
      backgroundAccentColor: '#f0e6f6',
      textDarkColor: '#2c3e50',
      textLightColor: '#7f8c8d',
      borderSoftColor: '#e2d7ea',
      surfaceSubtleColor: '#ffffff',
      surfaceMutedColor: '#faf7fd',
      successColor: '#27845b',
      warningColor: '#a7681f',
      dangerColor: '#c84646'
    }
  }),
  createThemePreset({
    key: 'sakura-cream',
    name: '樱花奶霜',
    description: '柔和玫粉配奶白表面，甜而不腻，适合轻松温暖的主页氛围。',
    values: {
      primaryColor: '#b54870',
      lightColor: '#e5a4bb',
      darkColor: '#87324f',
      backgroundColor: '#fff8fb',
      backgroundAccentColor: '#f8e4ec',
      textDarkColor: '#3d2933',
      textLightColor: '#7d6771',
      borderSoftColor: '#ead0da',
      surfaceSubtleColor: '#ffffff',
      surfaceMutedColor: '#fdf0f5',
      successColor: '#2f7d5c',
      warningColor: '#a56824',
      dangerColor: '#b94054'
    }
  }),
  createThemePreset({
    key: 'sea-salt-mint',
    name: '海盐薄荷',
    description: '清透的薄荷绿与雾白底色，让歌单、资料和商城页面更轻盈。',
    values: {
      primaryColor: '#2c7d72',
      lightColor: '#8ec9be',
      darkColor: '#205f57',
      backgroundColor: '#f4fbf9',
      backgroundAccentColor: '#dff1ec',
      textDarkColor: '#243a36',
      textLightColor: '#627a75',
      borderSoftColor: '#c7dfd9',
      surfaceSubtleColor: '#ffffff',
      surfaceMutedColor: '#eaf6f3',
      successColor: '#287a54',
      warningColor: '#a66a25',
      dangerColor: '#b94c59'
    }
  }),
  createThemePreset({
    key: 'blueberry-sky',
    name: '晴空蓝莓',
    description: '蓝紫主色配晴空浅底，信息层级清楚，适合内容和管理页面。',
    values: {
      primaryColor: '#5570c9',
      lightColor: '#9eafe8',
      darkColor: '#3c4f99',
      backgroundColor: '#f6f8ff',
      backgroundAccentColor: '#e3e9fa',
      textDarkColor: '#29314a',
      textLightColor: '#68718d',
      borderSoftColor: '#d1daf2',
      surfaceSubtleColor: '#ffffff',
      surfaceMutedColor: '#edf1fb',
      successColor: '#2f7f62',
      warningColor: '#a66c28',
      dangerColor: '#bd4e60'
    }
  }),
  createThemePreset({
    key: 'caramel-apricot',
    name: '焦糖杏桃',
    description: '杏桃橙与焦糖棕落在暖白背景上，适合温暖、有生活感的视觉。',
    values: {
      primaryColor: '#ad5835',
      lightColor: '#e8a780',
      darkColor: '#7e3f2a',
      backgroundColor: '#fff9f4',
      backgroundAccentColor: '#f8e5d7',
      textDarkColor: '#42312a',
      textLightColor: '#7b6a61',
      borderSoftColor: '#ead3c4',
      surfaceSubtleColor: '#ffffff',
      surfaceMutedColor: '#fdf0e7',
      successColor: '#35785a',
      warningColor: '#a7651d',
      dangerColor: '#b94b4f'
    }
  })
];
