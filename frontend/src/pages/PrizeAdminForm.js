import React from 'react';

export const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif';

const API_ORIGIN = (process.env.REACT_APP_API_URL || 'http://localhost:5000/api').replace(/\/api\/?$/, '');
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_SOURCE_IMAGE_BYTES = 20 * 1024 * 1024;
const COMPRESS_TARGET_BYTES = 900 * 1024;
const COMPRESS_MAX_EDGE = 1600;
const COMPRESSIBLE_IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

export function getImageUrl(url) {
  if (!url) return '/branding/chengzhi-sweety-logo.png';
  if (/^https?:|^data:/i.test(url)) return url;
  return url.startsWith('/uploads/') ? `${API_ORIGIN}${url}` : url;
}

export const getEmptyPrizeForm = () => ({
  name: '',
  description: '',
  cost: '',
  stock: '',
  delivery_type: 'physical',
  is_active: true,
  auto_carousel: true,
  options: []
});

export function createEmptyOption() {
  return {
    name: '',
    description: '',
    cost: '',
    stock: '',
    is_active: true
  };
}

export function formFromPrizeItem(item) {
  if (!item) return getEmptyPrizeForm();
  return {
    name: item.name || '',
    description: item.description || '',
    cost: item.cost ?? '',
    stock: item.stock ?? '',
    delivery_type: item.delivery_type === 'virtual' ? 'virtual' : 'physical',
    is_active: item.is_active !== 0,
    auto_carousel: item.auto_carousel !== 0,
    options: (item.options || []).map((option) => ({
      id: option.id,
      name: option.name || '',
      description: option.description || '',
      cost: option.cost ?? '',
      stock: option.stock ?? '',
      is_active: option.is_active !== 0
    }))
  };
}

export function buildPrizePayload(form) {
  const options = (form.options || [])
    .filter((option) => option.name.trim())
    .map((option, index) => ({
      id: option.id,
      name: option.name.trim(),
      description: option.description || '',
      cost: option.cost === '' ? Number(form.cost || 0) : Number(option.cost),
      stock: Number(option.stock || 0),
      is_active: Boolean(option.is_active),
      sort_order: index
    }));
  const activeOptions = options.filter((option) => option.is_active);

  return {
    name: form.name.trim(),
    description: form.description || '',
    cost: Number(form.cost || 0),
    stock: activeOptions.length
      ? activeOptions.reduce((sum, option) => sum + option.stock, 0)
      : Number(form.stock || 0),
    delivery_type: form.delivery_type === 'virtual' ? 'virtual' : 'physical',
    is_active: Boolean(form.is_active),
    auto_carousel: Boolean(form.auto_carousel),
    options
  };
}

function readImageBlob(blob, filename) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ data_url: reader.result, filename });
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function isCompressibleImage(file) {
  const type = (file.type || '').toLowerCase();
  return COMPRESSIBLE_IMAGE_TYPES.has(type) || /\.(jpe?g|png|webp)$/i.test(file.name || '');
}

function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`${file.name} 图片读取失败`)); };
    image.src = url;
  });
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('图片压缩失败')), 'image/webp', quality);
  });
}

async function compressImageFile(file) {
  const image = await loadImageElement(file);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const scale = Math.min(1, COMPRESS_MAX_EDGE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器不支持图片压缩');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  let bestBlob;
  for (const quality of [0.86, 0.79, 0.72]) {
    const blob = await canvasToBlob(canvas, quality);
    if (!bestBlob || blob.size < bestBlob.size) bestBlob = blob;
    if (blob.size <= COMPRESS_TARGET_BYTES) break;
  }
  return { blob: bestBlob, filename: (file.name || 'prize-image').replace(/\.[^.]+$/, '') + '.webp' };
}

export async function prepareImageFile(file) {
  if (!isCompressibleImage(file) || file.size <= COMPRESS_TARGET_BYTES) {
    return readImageBlob(file, file.name);
  }
  const compressed = await compressImageFile(file);
  if (compressed.blob.size > MAX_IMAGE_BYTES) throw new Error(`${file.name} 压缩后仍超过 5MB，请换一张更小的图片`);
  return readImageBlob(compressed.blob, compressed.filename);
}

export function validateImageFiles(files) {
  const notImage = files.find((file) => file.type && !file.type.startsWith('image/'));
  if (notImage) throw new Error(`${notImage.name} 不是支持的图片文件`);
  const oversized = files.find((file) => file.size > MAX_SOURCE_IMAGE_BYTES);
  if (oversized) throw new Error(`${oversized.name} 超过 20MB，请先压缩后再上传`);
  const oversizedGif = files.find((file) => !isCompressibleImage(file) && file.size > MAX_IMAGE_BYTES);
  if (oversizedGif) throw new Error(`${oversizedGif.name} 超过 5MB，动图请先压缩后再上传`);
}

export function getUploadErrorMessage(error) {
  if (error.response?.status === 413) return '图片请求过大，请检查服务器上传大小限制';
  return error.response?.data?.message || error.message;
}

export function PrizeBasicFields({ form, setForm }) {
  const activeOptions = (form.options || []).filter((option) => option.is_active);
  const optionStockTotal = activeOptions.reduce((sum, option) => sum + Number(option.stock || 0), 0);

  return <>
    <label>名称<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required /></label>
    <label>描述<textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} rows={4} /></label>
    <div className="prize-form-grid">
      <div className="delivery-type-field"><span>商品类型</span><div className="delivery-type-toggle" role="group" aria-label="商品类型">
        <button type="button" className={(form.delivery_type || 'physical') === 'physical' ? 'active physical' : 'physical'} onClick={() => setForm({ ...form, delivery_type: 'physical' })}>实体商品</button>
        <button type="button" className={form.delivery_type === 'virtual' ? 'active virtual' : 'virtual'} onClick={() => setForm({ ...form, delivery_type: 'virtual' })}>虚拟商品</button>
      </div></div>
      <label>默认积分价<input type="number" min="0" value={form.cost} onChange={(event) => setForm({ ...form, cost: event.target.value })} required /></label>
      {activeOptions.length > 0 ? <div className="stock-summary-field"><span>库存</span><strong>{optionStockTotal}</strong><small>{activeOptions.length} 个启用子选项库存合计</small></div> : <label>库存<input type="number" min="0" value={form.stock} onChange={(event) => setForm({ ...form, stock: event.target.value })} required /></label>}
    </div>
  </>;
}

export function PrizeStatusFields({ form, setForm }) {
  return <>
    <label className="toggle-line"><input type="checkbox" checked={form.is_active} onChange={(event) => setForm({ ...form, is_active: event.target.checked })} />上架显示</label>
    <label className="toggle-line"><input type="checkbox" checked={form.auto_carousel} onChange={(event) => setForm({ ...form, auto_carousel: event.target.checked })} />自动轮播图片</label>
  </>;
}

export function PrizeOptionsSummary({ form, onOpenFullEditor, onAddOption }) {
  const options = form.options || [];
  return <section className="prize-options-editor prize-options-summary-card">
    <div className="panel-toolbar compact-toolbar"><div><h3>子选项</h3><p>复杂规格在完整编辑弹窗管理，避免侧栏表单过长。</p></div></div>
    {options.length ? <div className="option-summary-list">{options.slice(0, 3).map((option, index) => <span key={option.id || index}>{option.name || `选项 ${index + 1}`}</span>)}{options.length > 3 && <span>+{options.length - 3}</span>}</div> : <div className="empty-inline">未设置子选项，用户会直接兑换这个礼物。</div>}
    <div className="option-summary-actions"><button type="button" className="secondary-action" onClick={onOpenFullEditor}>进入完整编辑</button><button type="button" className="secondary-action" onClick={onAddOption}>添加子选项</button></div>
  </section>;
}

export function PrizeOptionsEditor({ form, setForm }) {
  const updateOption = (index, patch) => setForm((current) => ({ ...current, options: current.options.map((option, optionIndex) => optionIndex === index ? { ...option, ...patch } : option) }));
  const addOption = () => setForm((current) => ({ ...current, options: [...current.options, createEmptyOption()] }));
  const removeOption = (index) => setForm((current) => ({ ...current, options: current.options.filter((_, optionIndex) => optionIndex !== index) }));
  const moveOption = (index, direction) => setForm((current) => {
    const options = [...current.options];
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= options.length) return current;
    [options[index], options[nextIndex]] = [options[nextIndex], options[index]];
    return { ...current, options };
  });

  return <section className="prize-options-editor">
    <div className="panel-toolbar compact-toolbar"><div><h3>子选项</h3><p>可用于颜色、尺寸或规格；积分留空会继承商品默认价。</p></div><button type="button" className="secondary-action" onClick={addOption}>添加选项</button></div>
    {!form.options.length ? <div className="empty-inline">未设置子选项，用户会直接兑换这个礼物。</div> : <div className="prize-option-editor-list">{form.options.map((option, index) => <div key={option.id || index} className="prize-option-editor-row">
      <div className="option-row-header"><strong>选项 {index + 1}</strong><div className="row-actions"><button type="button" onClick={() => moveOption(index, -1)} disabled={index === 0}>上移</button><button type="button" onClick={() => moveOption(index, 1)} disabled={index === form.options.length - 1}>下移</button><button type="button" className="danger-text" onClick={() => removeOption(index)}>删除</button></div></div>
      <div className="prize-option-compact-grid">
        <label>选项名称<input value={option.name} onChange={(event) => updateOption(index, { name: event.target.value })} placeholder="例如：紫色" /></label>
        <label>独立库存<input type="number" min="0" value={option.stock} onChange={(event) => updateOption(index, { stock: event.target.value })} placeholder="0" /></label>
        <label>积分价格<input type="number" min="0" value={option.cost} onChange={(event) => updateOption(index, { cost: event.target.value })} placeholder="留空继承" /></label>
        <label>选项描述<textarea value={option.description} onChange={(event) => updateOption(index, { description: event.target.value })} rows={1} placeholder="可选说明" /></label>
        <label className="toggle-line prize-option-toggle"><input type="checkbox" checked={option.is_active} onChange={(event) => updateOption(index, { is_active: event.target.checked })} />启用</label>
      </div>
    </div>)}</div>}
  </section>;
}
