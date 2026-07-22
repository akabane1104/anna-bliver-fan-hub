import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { prizeService } from '../services';
import BackButton from '../components/BackButton';
import './AdminPrizeOrders.css';

const STATUSES = ['pending', 'processing', 'shipped', 'completed', 'cancelled', 'rejected'];
const STATUS_LABELS = { pending: '待处理', processing: '处理中', shipped: '已发货', completed: '已完成', cancelled: '已取消', rejected: '已拒绝', refunded: '已退款' };
const unwrap = (response) => response?.data || response || [];
const formatDate = (value) => value ? new Date(value).toLocaleString() : '-';
const statusLabel = (value) => STATUS_LABELS[value] || value || '-';
const addressText = (order) => [order?.recipient_name_snapshot, order?.phone_snapshot, `${order?.region_snapshot || ''}${order?.detail_address_snapshot || ''}`].filter(Boolean).join(' ');

export default function AdminPrizeOrders() {
  const [orders, setOrders] = useState([]);
  const [selected, setSelected] = useState(null);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setOrders(unwrap(await prizeService.getAdminOrders(status ? { status } : {}))); }
    catch (err) { setError(err.response?.data?.message || '订单加载失败'); }
    finally { setLoading(false); }
  }, [status]);
  useEffect(() => { load(); }, [load]);

  const visibleOrders = useMemo(() => orders.filter((order) => {
    const keyword = search.trim().toLowerCase();
    const matchesSearch = !keyword || [order.id, order.username, order.email, order.recipient_name_snapshot, order.phone_snapshot].some((value) => String(value || '').toLowerCase().includes(keyword));
    const created = order.created_at ? new Date(order.created_at) : null;
    const matchesStart = !startDate || (created && created >= new Date(`${startDate}T00:00:00`));
    const matchesEnd = !endDate || (created && created <= new Date(`${endDate}T23:59:59`));
    return matchesSearch && matchesStart && matchesEnd;
  }), [orders, search, startDate, endDate]);

  const open = async (id) => {
    setError(''); setReason('');
    try { setSelected(unwrap(await prizeService.getAdminOrder(id))); }
    catch (err) { setError(err.response?.data?.message || '订单详情加载失败'); }
  };

  const update = async (nextStatus) => {
    if (['cancelled', 'rejected'].includes(nextStatus) && !reason.trim()) return setError('取消或拒绝订单时请填写原因');
    setSaving(true); setError('');
    try {
      const result = unwrap(await prizeService.updateOrderStatus(selected.id, nextStatus, reason));
      setSelected(result); setMessage(`订单 #${selected.id} 已更新为${statusLabel(nextStatus)}`); await load();
    } catch (err) { setError(err.response?.data?.message || '订单状态更新失败'); }
    finally { setSaving(false); }
  };

  return <div className="admin-prize-orders">
    <BackButton to="/" />
    <header className="admin-prize-orders-header"><div><h1>兑换订单管理</h1><p>查看收货信息、处理状态并执行取消退款。</p></div><button type="button" className="btn btn-secondary" onClick={load}>刷新订单</button></header>
    {message && <div className="form-success">{message}</div>}{error && <div className="form-error">{error}</div>}
    <section className="admin-order-panel">
      <div className="admin-order-filters"><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="订单号、用户、邮箱或收件人" /><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">全部状态</option>{STATUSES.map((value) => <option value={value} key={value}>{statusLabel(value)}</option>)}</select><input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} aria-label="开始日期" /><input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} aria-label="结束日期" /></div>
      {loading ? <div className="empty-inline">正在加载订单...</div> : !visibleOrders.length ? <div className="empty-inline">没有匹配的订单</div> : <div className="admin-order-list">{visibleOrders.map((order) => <button type="button" className="admin-order-row" key={order.id} onClick={() => open(order.id)}><div><strong>订单 #{order.id}</strong><span>{order.username} · {order.email}</span></div><div><strong>{order.recipient_name_snapshot || '虚拟商品订单'}</strong><span>{order.prize_names || `${order.line_count || 0} 个项目`}</span></div><div><strong>{Number(order.points_total || 0).toLocaleString()} 积分</strong><span className={`status-pill ${order.status}`}>{statusLabel(order.status)}</span></div><time>{formatDate(order.created_at)}</time></button>)}</div>}
    </section>

    {selected && <div className="admin-order-modal" role="dialog" aria-modal="true" onClick={() => setSelected(null)}><section className="admin-order-modal-content" onClick={(event) => event.stopPropagation()}>
      <button type="button" className="admin-order-close" onClick={() => setSelected(null)} aria-label="关闭">×</button><header className="admin-order-detail-header"><div><p>商城兑换订单</p><h2>订单 #{selected.id}</h2><span>{formatDate(selected.created_at)}</span></div><div className="admin-order-detail-status"><span className={`status-pill ${selected.status}`}>{statusLabel(selected.status)}</span><strong>{Number(selected.points_total || 0).toLocaleString()} 积分</strong></div></header>
      <div className={`admin-order-address ${selected.recipient_name_snapshot ? '' : 'virtual'}`}><div><h3>{selected.recipient_name_snapshot ? '收货信息' : '虚拟商品订单'}</h3><p>{selected.recipient_name_snapshot ? addressText(selected) : '该订单无需收货地址'}</p></div>{selected.status_reason && <p>处理说明：{selected.status_reason}</p>}</div>
      <div className="admin-order-items"><h3>兑换项目</h3>{(selected.items || []).map((item) => <article className="admin-order-item" key={item.id}><img src="/branding/chengzhi-sweety-logo.png" alt={item.prize_name} /><div><strong>{item.prize_name}</strong><span>{item.option_name || '默认规格'} · x{item.quantity || 1}</span><span>{Number(item.points_cost || 0).toLocaleString()} 积分</span>{item.user_remark && <p>用户备注：{item.user_remark}</p>}</div><div className="admin-order-item-actions"><span className={`status-pill ${item.status}`}>{statusLabel(item.status)}</span></div></article>)}</div>
      <label className="prize-checkout-remark">处理备注<textarea value={reason} onChange={(event) => setReason(event.target.value)} rows="3" placeholder="取消或拒绝时必填" /></label><div className="admin-order-detail-actions">{STATUSES.map((value) => <button type="button" className={['cancelled', 'rejected'].includes(value) ? 'btn btn-outline' : 'btn btn-secondary'} key={value} disabled={saving || selected.status === value} onClick={() => update(value)}>{statusLabel(value)}</button>)}</div>
    </section></div>}
  </div>;
}
