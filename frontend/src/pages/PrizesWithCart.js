import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { authService, prizeService } from '../services';
import BackButton from '../components/BackButton';

const API_ORIGIN = (process.env.REACT_APP_API_URL || 'http://localhost:5000/api').replace(/\/api\/?$/, '');
const imageUrl = (value) => {
  if (!value) return '/branding/chengzhi-sweety-logo.png';
  if (/^https?:|^data:/i.test(value)) return value;
  return value.startsWith('/uploads/') ? `${API_ORIGIN}${value}` : value;
};
const activeOptions = (prize) => (prize?.options || []).filter((option) => option.is_active !== 0);
const unitCost = (prize, option) => Number(option?.cost ?? prize?.cost ?? 0);
const stockOf = (prize, option) => Number(option?.stock ?? prize?.stock ?? 0);
const deliveryLabel = (value) => value === 'virtual' ? '虚拟商品' : '实体商品';
const emptyAddress = { recipient_name: '', phone: '', province: '', city: '', district: '', address_line: '', postal_code: '', is_default: false };

const prizeImages = (prize) => {
  const images = (prize?.images || []).filter((item) => item?.image_url);
  return images.length ? images : [{ id: 'fallback', image_url: prize?.image_url || '/branding/chengzhi-sweety-logo.png' }];
};

function PrizeGallery({ prize, onPreview, compact = false }) {
  const images = prizeImages(prize);
  const [index, setIndex] = useState(0);
  const current = Math.min(index, images.length - 1);
  const move = (next) => setIndex((next + images.length) % images.length);
  return <>
    <div className={`prize-image-gallery ${compact ? 'prize-image-gallery-static' : ''}`}>
      <div className="prize-gallery-track" style={{ transform: `translateX(-${current * 100}%)` }}>
        {images.map((item, imageIndex) => <button key={item.id || imageIndex} type="button" className="prize-gallery-preview-trigger" onClick={(event) => { event.stopPropagation(); onPreview?.(prize, imageIndex); }}><img src={imageUrl(item.image_url)} alt={prize?.name || '商品图片'} className="prize-gallery-image" /></button>)}
      </div>
      {images.length > 1 && <><button type="button" className="prize-gallery-nav prize-gallery-nav-prev" aria-label="上一张商品图片" onClick={(event) => { event.stopPropagation(); move(current - 1); }}>‹</button><button type="button" className="prize-gallery-nav prize-gallery-nav-next" aria-label="下一张商品图片" onClick={(event) => { event.stopPropagation(); move(current + 1); }}>›</button></>}
    </div>
    {images.length > 1 && <div className="prize-gallery-dots">{images.map((item, imageIndex) => <button key={item.id || imageIndex} type="button" className={`prize-gallery-dot ${imageIndex === current ? 'active' : ''}`} aria-label={`第 ${imageIndex + 1} 张图片`} onClick={() => setIndex(imageIndex)} />)}</div>}
  </>;
}

export default function PrizesWithCart() {
  const [prizes, setPrizes] = useState([]);
  const [cartItems, setCartItems] = useState([]);
  const [addresses, setAddresses] = useState([]);
  const [currentUser, setCurrentUser] = useState(authService.getCurrentUser());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cartOpen, setCartOpen] = useState(false);
  const [redeemPrize, setRedeemPrize] = useState(null);
  const [selectedOptionId, setSelectedOptionId] = useState('');
  const [redeemQuantity, setRedeemQuantity] = useState(1);
  const [checkout, setCheckout] = useState(null);
  const [addressId, setAddressId] = useState('');
  const [addressForm, setAddressForm] = useState(emptyAddress);
  const [addressFormVisible, setAddressFormVisible] = useState(false);
  const [editingAddressId, setEditingAddressId] = useState(null);
  const [remark, setRemark] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState(null);

  const authenticated = authService.isAuthenticated();
  const loadCart = useCallback(async () => {
    if (!authenticated) return setCartItems([]);
    setCartItems(await prizeService.getCart());
  }, [authenticated]);

  useEffect(() => {
    Promise.all([prizeService.getAllPrizes(), loadCart(), authenticated ? prizeService.getShippingAddresses() : []])
      .then(([items, , addressRows]) => { setPrizes(items || []); setAddresses(addressRows || []); setAddressId(String(addressRows?.find((item) => item.is_default)?.id || addressRows?.[0]?.id || '')); })
      .catch((err) => setError(err.response?.data?.message || '商城加载失败'))
      .finally(() => setLoading(false));
  }, [authenticated, loadCart]);

  const selectedOption = activeOptions(redeemPrize).find((option) => String(option.id) === String(selectedOptionId));
  const selectedCost = unitCost(redeemPrize, selectedOption) * redeemQuantity;
  const selectedStock = stockOf(redeemPrize, selectedOption);
  const needsOption = activeOptions(redeemPrize).length > 0 && !selectedOption;

  const isRedeemConfirmDisabled = !redeemPrize || needsOption || redeemQuantity < 1 || redeemQuantity > selectedStock;

  const openPrize = (prize) => {
    const options = activeOptions(prize);
    setRedeemPrize(prize); setSelectedOptionId(options.length === 1 ? String(options[0].id) : ''); setRedeemQuantity(1); setMessage('');
  };

  const handleAddToCart = async () => {
    if (!authenticated) return setMessage('请先登录后使用购物车');
    if (isRedeemConfirmDisabled) return;
    setBusy(true);
    try {
      const nextCart = await prizeService.addCartItem({ prize_id: redeemPrize.id, prize_option_id: selectedOption?.id || null, quantity: redeemQuantity, currency_type: 'points' });
      setCartItems(Array.isArray(nextCart) ? nextCart : []);
      setRedeemPrize(null); setCartOpen(true);
    } catch (err) { setMessage(err.response?.data?.message || '加入购物车失败'); }
    finally { setBusy(false); }
  };

  const handleConfirmRedeem = () => {
    if (!authenticated) return setMessage('请先登录后兑换');
    if (isRedeemConfirmDisabled) return;
    setCheckout({ mode: 'direct', prize: redeemPrize, option: selectedOption, quantity: redeemQuantity, points: selectedCost });
    setRedeemPrize(null);
  };

  const updateCartItem = async (id, data) => {
    setBusy(true);
    try { setCartItems(await prizeService.updateCartItem(id, { ...data, currency_type: 'points' })); }
    finally { setBusy(false); }
  };

  const removeCartItem = async (id) => {
    setBusy(true);
    try { setCartItems(await prizeService.deleteCartItem(id)); }
    finally { setBusy(false); }
  };

  const clearCart = async () => {
    setBusy(true);
    try { await prizeService.clearCart(); setCartItems([]); }
    finally { setBusy(false); }
  };

  const cartTotal = useMemo(() => cartItems.reduce((sum, item) => sum + Number(item.currency_cost ?? (Number(item.cost || 0) * Number(item.quantity || 0))), 0), [cartItems]);
  const cartHasPhysical = cartItems.some((item) => item.delivery_type !== 'virtual');

  const checkoutCart = () => {
    if (!cartItems.length) return;
    setCheckout({ mode: 'cart', points: cartTotal, physical: cartHasPhysical });
    setCartOpen(false);
  };

  const applyRemainingBalances = (remainingBalances = {}) => {
    const user = authService.getCurrentUser();
    if (!user || remainingBalances.points === undefined) return;
    const updatedUser = { ...user, points: remainingBalances.points };
    authService.setCurrentUser(updatedUser);
    setCurrentUser(updatedUser);
  };

  const saveAddress = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = editingAddressId
        ? await prizeService.updateShippingAddress(editingAddressId, addressForm)
        : await prizeService.createShippingAddress(addressForm);
      const next = await prizeService.getShippingAddresses();
      setAddresses(next); setAddressId(String(result.id || editingAddressId)); setAddressForm(emptyAddress); setEditingAddressId(null); setAddressFormVisible(false);
    } catch (err) { setMessage(err.response?.data?.message || '地址保存失败'); }
    finally { setBusy(false); }
  };

  const editAddress = (address) => {
    setEditingAddressId(address.id);
    setAddressForm({ ...emptyAddress, ...address, is_default: Boolean(address.is_default) });
    setAddressFormVisible(true);
  };

  const deleteAddress = async (id) => {
    if (!window.confirm('确认删除这个收货地址？')) return;
    setBusy(true);
    try {
      await prizeService.deleteShippingAddress(id);
      const next = await prizeService.getShippingAddresses();
      setAddresses(next);
      if (String(addressId) === String(id)) setAddressId(String(next[0]?.id || ''));
    } finally { setBusy(false); }
  };

  const makeDefaultAddress = async (id) => {
    setBusy(true);
    try { await prizeService.setDefaultShippingAddress(id); setAddresses(await prizeService.getShippingAddresses()); setAddressId(String(id)); }
    finally { setBusy(false); }
  };

  const submitCheckout = async () => {
    const needsAddress = checkout.mode === 'cart' ? checkout.physical : checkout.prize.delivery_type !== 'virtual';
    if (needsAddress && !addressId) return setMessage('请选择收货地址');
    setBusy(true); setMessage('');
    try {
      const result = checkout.mode === 'cart'
        ? await prizeService.checkoutCart({ address_id: addressId || null, remark })
        : await prizeService.redeemPrize(checkout.prize.id, { prizeOptionId: checkout.option?.id || null, quantity: checkout.quantity, addressId: addressId || null, remark, currencyType: 'points' });
      applyRemainingBalances(result.remainingBalances || { points: result.remaining_points });
      await loadCart();
      setCheckout(null); setRemark(''); setMessage(`兑换成功，订单号 #${result.order_id}`);
    } catch (err) { setMessage(err.response?.data?.message || '结算失败'); }
    finally { setBusy(false); }
  };

  if (loading) return <div className="loading">正在加载积分商城...</div>;

  const checkoutItems = checkout?.mode === 'cart' ? cartItems : checkout ? [{
    key: 'direct', name: checkout.prize.name, image_url: checkout.option?.image_url || checkout.prize.images?.[0]?.image_url || checkout.prize.image_url,
    option_name: checkout.option?.name, quantity: checkout.quantity, points: checkout.points, delivery_type: checkout.prize.delivery_type
  }] : [];
  const checkoutNeedsAddress = checkout?.mode === 'cart' ? checkout?.physical : checkout?.prize?.delivery_type !== 'virtual';
  const currentBalance = Number(currentUser?.points || 0);
  const previewImages = preview ? prizeImages(preview.prize) : [];

  return <div className="container">
    <BackButton to="/" />
    <header className="prizes-page-header"><h1 className="page-title">积分商城</h1><p className="page-subtitle">使用社区积分兑换专属礼物吧！当前积分：{currentBalance.toLocaleString()}</p></header>
    <button type="button" className="prize-cart-fab" onClick={() => setCartOpen(true)} aria-label={`打开购物车，共 ${cartItems.length} 项`}><svg className="prize-cart-fab-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 18c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm10 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zM7.2 14h9.9c.75 0 1.4-.41 1.74-1.03L22 7.25 20.26 6l-3.16 5.5H7.63L4.27 4H1v2h2l3.6 7.59L5.25 16A2 2 0 0 0 7 19h12v-2H7.42a.25.25 0 0 1-.22-.37L7.2 14z" /></svg>{cartItems.length > 0 && <span className="prize-cart-fab-count">{cartItems.length > 99 ? '99+' : cartItems.length}</span>}</button>
    {(error || message) && <div className={`prize-notice ${error ? 'prize-notice-error' : 'prize-notice-success'}`} role={error ? 'alert' : 'status'}><span>{error || message}</span></div>}

    {!prizes.length ? <div className="empty-state"><div className="empty-state-icon">🎁</div><p>暂无商品</p></div> : <div className="grid">{prizes.map((prize) => {
      const options = activeOptions(prize);
      const costs = options.length ? options.map((item) => Number(item.cost)) : [Number(prize.cost || 0)];
      const minCost = Math.min(...costs); const maxCost = Math.max(...costs); const available = Number(prize.stock || 0) > 0;
      return <article className={`card prize-card prize-card-clickable ${available ? '' : 'prize-card-disabled'}`} key={prize.id} onClick={() => available && openPrize(prize)}>
        <PrizeGallery prize={prize} onPreview={(item, index) => setPreview({ prize: item, index })} />
        <h2 className="card-title">{prize.name}</h2><div className={`prize-delivery-chip ${prize.delivery_type === 'virtual' ? 'virtual' : 'physical'}`}>{deliveryLabel(prize.delivery_type)}</div><p className="card-description">{prize.description || '暂无描述'}</p>
        <div className="prize-card-footer"><div className="prize-card-price-line"><span className="prize-card-price-pill">{minCost}{maxCost !== minCost ? `–${maxCost}` : ''} 积分</span></div><div className="prize-card-meta-line"><span>库存 {prize.stock || 0}</span>{options.length > 0 && <span>{options.length} 个选项</span>}</div><div className="prize-redeem-actions"><button type="button" className="btn btn-primary" disabled={!available} onClick={(event) => { event.stopPropagation(); openPrize(prize); }}>{available ? '选择兑换' : '库存不足'}</button></div></div>
      </article>;
    })}</div>}

    {redeemPrize && <div className="prize-redeem-modal" role="dialog" aria-modal="true" onClick={() => setRedeemPrize(null)}><div className="prize-redeem-modal-content" onClick={(event) => event.stopPropagation()}>
      <button type="button" className="prize-redeem-modal-close" onClick={() => setRedeemPrize(null)} aria-label="关闭">×</button>
      <div className="prize-redeem-modal-image"><PrizeGallery prize={redeemPrize} onPreview={(item, index) => setPreview({ prize: item, index })} /></div>
      <div className="prize-redeem-modal-detail"><div className="prize-purchase-header"><p className="prize-redeem-eyebrow">礼物兑换</p><h2>{redeemPrize.name}</h2><div className={`prize-delivery-chip inline ${redeemPrize.delivery_type === 'virtual' ? 'virtual' : 'physical'}`}>{deliveryLabel(redeemPrize.delivery_type)}</div><div className="prize-price-hero"><div className="prize-price-hero-item"><span>积分单价</span><strong>{unitCost(redeemPrize, selectedOption)} 积分</strong></div></div><p className="prize-redeem-description">{redeemPrize.description || '暂无描述'}</p></div>
        {activeOptions(redeemPrize).length > 0 && <section className="prize-option-section"><h3>选择商品选项</h3><div className="prize-option-list">{activeOptions(redeemPrize).map((option) => <button key={option.id} type="button" className={`prize-option-choice ${String(option.id) === selectedOptionId ? 'selected' : ''}`} disabled={Number(option.stock || 0) <= 0} onClick={() => setSelectedOptionId(String(option.id))}><span>{option.name}</span><small>库存 {option.stock}</small><span className="prize-option-price-summary">{option.cost} 积分</span></button>)}</div></section>}
        <div className="prize-purchase-row"><div className="prize-purchase-row-copy"><span>兑换数量</span><small>当前库存 {selectedStock}</small></div><div className="quantity-control"><button type="button" disabled={redeemQuantity <= 1} onClick={() => setRedeemQuantity((value) => Math.max(1, value - 1))}>−</button><input type="number" min="1" max={selectedStock} value={redeemQuantity} onChange={(event) => setRedeemQuantity(Math.max(1, Number(event.target.value)))} /><button type="button" disabled={redeemQuantity >= selectedStock} onClick={() => setRedeemQuantity((value) => Math.min(selectedStock, value + 1))}>+</button></div></div>
        <section className="prize-payment-section"><h3>积分支付</h3><button type="button" className={`prize-payment-option selected ${currentBalance < selectedCost ? 'disabled' : ''}`} disabled={currentBalance < selectedCost}><span className="prize-payment-main"><span className="prize-payment-name">社区积分</span><span className="prize-payment-formula">{unitCost(redeemPrize, selectedOption)} × {redeemQuantity} = {selectedCost} 积分</span></span><span className="prize-payment-meta"><span className="prize-payment-cost">实付 {selectedCost} 积分</span><span className="prize-payment-balance">余额：{currentBalance} 积分</span><span className={`prize-payment-status ${currentBalance < selectedCost ? 'insufficient' : ''}`}>{currentBalance < selectedCost ? '余额不足' : '已选择'}</span></span></button></section>
        {message && <div className="prize-redeem-modal-error">{message}</div>}
        <div className="prize-modal-actions"><button type="button" className="btn btn-secondary prize-redeem-confirm" onClick={handleAddToCart} disabled={busy || isRedeemConfirmDisabled || currentBalance < selectedCost}>加入购物车</button><button type="button" className="btn btn-primary prize-redeem-confirm" onClick={handleConfirmRedeem} disabled={busy || isRedeemConfirmDisabled || currentBalance < selectedCost}>立即兑换</button></div>
      </div>
    </div></div>}

    {cartOpen && <div className="prize-cart-overlay" role="dialog" aria-modal="true" onClick={() => setCartOpen(false)}><aside className="prize-cart-panel" onClick={(event) => event.stopPropagation()}>
      <div className="prize-cart-header"><div><p className="prize-redeem-eyebrow">积分商城</p><h2>购物车</h2></div><button type="button" className="prize-redeem-modal-close" onClick={() => setCartOpen(false)} aria-label="关闭">×</button></div>
      {!cartItems.length ? <div className="empty-inline">购物车还是空的</div> : <div className="prize-cart-list">{cartItems.map((item) => <div className={`prize-cart-item ${item.is_available === false ? 'invalid' : ''}`} key={item.id}><img src={imageUrl(item.image_url)} alt={item.name} /><div className="prize-cart-item-main"><div className="prize-cart-item-title"><strong>{item.name}</strong>{item.option_name && <span>{item.option_name}</span>}<span className={`prize-cart-delivery ${item.delivery_type === 'virtual' ? 'virtual' : 'physical'}`}>{deliveryLabel(item.delivery_type)}</span></div>{item.unavailable_reason && <div className="prize-cart-warning">{item.unavailable_reason}</div>}<div className="prize-cart-controls"><div className="quantity-control"><button type="button" disabled={busy || item.quantity <= 1} onClick={() => updateCartItem(item.id, { quantity: item.quantity - 1 })}>−</button><input type="number" min="1" max={item.stock} value={item.quantity} onChange={(event) => updateCartItem(item.id, { quantity: Number(event.target.value) })} /><button type="button" disabled={busy || item.quantity >= item.stock} onClick={() => updateCartItem(item.id, { quantity: item.quantity + 1 })}>+</button></div></div><div className="prize-cart-item-footer"><span>小计：{Number(item.currency_cost ?? item.cost * item.quantity)} 积分</span><button type="button" className="danger-text" onClick={() => removeCartItem(item.id)}>移除</button></div></div></div>)}</div>}
      <div className="prize-cart-summary"><div><span>积分合计</span><strong>{cartTotal} 积分</strong></div>{cartTotal > currentBalance && <p className="prize-cart-warning">积分余额不足</p>}</div><div className="prize-cart-actions"><button type="button" className="btn btn-outline" onClick={clearCart} disabled={busy || !cartItems.length}>清空</button><button type="button" className="btn btn-primary" onClick={checkoutCart} disabled={!cartItems.length || busy || cartTotal > currentBalance}>结算购物车</button></div>
    </aside></div>}

    {checkout && <div className="prize-checkout-modal" role="dialog" aria-modal="true" onClick={() => setCheckout(null)}><div className="prize-checkout-modal-content" onClick={(event) => event.stopPropagation()}>
      <button type="button" className="prize-redeem-modal-close" onClick={() => setCheckout(null)} aria-label="关闭">×</button><header className="prize-checkout-header"><p className="prize-redeem-eyebrow">积分商城</p><h2>确认结算</h2><span>请核对商品、地址与备注</span></header>
      <div className="prize-checkout-list">{checkoutItems.map((item) => <div className="prize-checkout-item" key={item.key || item.id}><img src={imageUrl(item.image_url)} alt={item.name} /><div className="prize-checkout-item-main"><div><strong>{item.name}</strong>{item.option_name && <span className="prize-checkout-muted">{item.option_name}</span>}<span className={`prize-cart-delivery ${item.delivery_type === 'virtual' ? 'virtual' : 'physical'}`}>{deliveryLabel(item.delivery_type)}</span></div><div className="prize-checkout-line-meta"><span>数量 {item.quantity}</span><span>{Number(item.points ?? item.currency_cost ?? item.cost * item.quantity)} 积分</span></div></div></div>)}</div>
      {checkoutNeedsAddress && <section className="prize-address-section"><div className="prize-address-section-header"><div><h3>收货地址</h3><p>实体商品需要填写有效地址。</p></div><button type="button" className="btn btn-outline" onClick={() => { setEditingAddressId(null); setAddressForm(emptyAddress); setAddressFormVisible(true); }}>新增地址</button></div>
        <div className="prize-address-list">{addresses.map((address) => <label key={address.id} className={`prize-address-card ${String(addressId) === String(address.id) ? 'selected' : ''}`}><input type="radio" checked={String(addressId) === String(address.id)} onChange={() => setAddressId(String(address.id))} /><span><strong>{address.recipient_name} · {address.phone}</strong><small>{address.province}{address.city}{address.district}{address.address_line}</small>{address.is_default ? <em>默认地址</em> : null}</span><span className="prize-address-actions"><button type="button" onClick={(event) => { event.preventDefault(); editAddress(address); }}>编辑</button>{!address.is_default && <button type="button" onClick={(event) => { event.preventDefault(); makeDefaultAddress(address.id); }}>设为默认</button>}<button type="button" className="danger-text" onClick={(event) => { event.preventDefault(); deleteAddress(address.id); }}>删除</button></span></label>)}</div>
        {(addressFormVisible || !addresses.length) && <form className="prize-address-form" onSubmit={saveAddress}><div className="prize-address-form-grid">{[['recipient_name','收件人'],['phone','手机号'],['province','省'],['city','市'],['district','区/县'],['address_line','详细地址'],['postal_code','邮编（选填）']].map(([field, label]) => <label key={field}>{label}<input value={addressForm[field]} onChange={(event) => setAddressForm({ ...addressForm, [field]: event.target.value })} required={['recipient_name','phone','address_line'].includes(field)} /></label>)}</div><label className="toggle-line"><input type="checkbox" checked={addressForm.is_default} onChange={(event) => setAddressForm({ ...addressForm, is_default: event.target.checked })} />设为默认地址</label><div className="prize-address-form-actions">{addresses.length > 0 && <button type="button" className="btn btn-outline" onClick={() => { setAddressFormVisible(false); setEditingAddressId(null); }}>取消</button>}<button className="btn btn-secondary" disabled={busy}>{busy ? '保存中...' : '保存地址'}</button></div></form>}
      </section>}
      <label className="prize-checkout-remark">订单备注<textarea value={remark} onChange={(event) => setRemark(event.target.value)} rows="3" placeholder="可选：填写规格、联系方式等补充信息" /></label><div className="prize-checkout-summary"><div><span>积分合计</span><strong>{checkout.points} 积分</strong></div>{checkoutNeedsAddress && !addressId && <p className="prize-cart-warning">请选择收货地址后再提交。</p>}</div>{message && <div className="prize-redeem-modal-error">{message}</div>}<div className="prize-modal-actions"><button type="button" className="btn btn-outline" onClick={() => setCheckout(null)}>返回修改</button><button type="button" className="btn btn-primary" onClick={submitCheckout} disabled={busy || (checkoutNeedsAddress && !addressId)}>{busy ? '提交中...' : '确认提交'}</button></div>
    </div></div>}

    {preview && <div className="prize-image-modal" role="dialog" aria-modal="true" onClick={() => setPreview(null)}><div className="prize-image-modal-content" onClick={(event) => event.stopPropagation()}><button type="button" className="prize-image-modal-close" onClick={() => setPreview(null)}>×</button>{previewImages.length > 1 && <button type="button" className="prize-image-modal-nav prize-image-modal-nav-prev" onClick={() => setPreview({ ...preview, index: (preview.index - 1 + previewImages.length) % previewImages.length })}>‹</button>}<div className="prize-image-modal-viewport"><div className="prize-image-modal-track" style={{ transform: `translateX(-${preview.index * 100}%)` }}>{previewImages.map((item, index) => <div className="prize-image-modal-slide" key={item.id || index}><img src={imageUrl(item.image_url)} alt={preview.prize.name} /></div>)}</div></div>{previewImages.length > 1 && <><button type="button" className="prize-image-modal-nav prize-image-modal-nav-next" onClick={() => setPreview({ ...preview, index: (preview.index + 1) % previewImages.length })}>›</button><div className="prize-image-modal-count">{preview.index + 1} / {previewImages.length}</div></>}</div></div>}
  </div>;
}
