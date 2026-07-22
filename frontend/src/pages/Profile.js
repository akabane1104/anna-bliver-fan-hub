import React, { useCallback, useEffect, useState } from 'react';
import { authService, pointsService, prizeService } from '../services';
import BackButton from '../components/BackButton';
import BilibiliBinding from '../components/BilibiliBinding';
import './Profile.css';

const SOURCE_LABELS = {
  auto_bilibili: 'B站投喂折算',
  manual_adjustment: '管理员调整',
  csv_import: 'CSV 批量调整',
  redemption: '商城兑换',
  redemption_refund: '兑换退款'
};
const EMPTY_FILTERS = { source: 'all', direction: 'all', start_date: '', end_date: '', keyword: '' };
const PAGE_SIZE = 20;
const API_ORIGIN = (process.env.REACT_APP_API_URL || 'http://localhost:5000/api').replace(/\/api\/?$/, '');

const formatNumber = (value) => Number(value || 0).toLocaleString();
const formatDate = (value) => value && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toLocaleString() : '-';
const imageUrl = (value) => !value ? '/branding/chengzhi-sweety-logo.png' : /^https?:|^data:/i.test(value) ? value : `${API_ORIGIN}${value}`;
const roleLabel = (role) => ({ admin: '管理员', premium: '主播', user: '普通用户' }[role] || role || '-');
const statusLabel = (status) => ({ pending: '处理中', completed: '已完成', cancelled: '已取消', mixed: '部分处理' }[status] || status || '-');
const deliveryLabel = (value) => value === 'virtual' ? '虚拟商品' : '实体商品';
const orderDeliveryLabel = (order) => Number(order?.has_physical || 0) ? '含实体商品' : '仅虚拟商品';
const orderAddress = (order) => [order?.recipient_name_snapshot, order?.phone_snapshot, `${order?.region_snapshot || ''}${order?.detail_address_snapshot || ''}`].filter(Boolean).join(' ');

function Profile() {
  const [user, setUser] = useState(null);
  const [summary, setSummary] = useState(null);
  const [orders, setOrders] = useState([]);
  const [expandedOrderId, setExpandedOrderId] = useState(null);
  const [orderDetails, setOrderDetails] = useState({});
  const [orderLoadingId, setOrderLoadingId] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [filters, setFilters] = useState({ ...EMPTY_FILTERS });
  const [draftFilters, setDraftFilters] = useState({ ...EMPTY_FILTERS });
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1, total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [orderError, setOrderError] = useState('');

  useEffect(() => {
    Promise.all([authService.getProfile(), pointsService.getSummary(), prizeService.getUserOrders()])
      .then(([profile, pointSummary, orderRows]) => {
        setUser(profile);
        setSummary(pointSummary);
        setOrders(orderRows || []);
      })
      .catch((err) => setError(err.response?.data?.message || '个人资料加载失败'))
      .finally(() => setLoading(false));
  }, []);

  const loadTransactions = useCallback(async (page = 1, nextFilters = filters) => {
    setHistoryLoading(true);
    setHistoryError('');
    try {
      const data = await pointsService.getTransactions(page, PAGE_SIZE, nextFilters);
      setTransactions(data.transactions || []);
      setPagination(data.pagination || { page, totalPages: 1, total: 0 });
      setHistoryLoaded(true);
    } catch (err) {
      setHistoryError(err.response?.data?.message || '积分变动明细加载失败');
    } finally {
      setHistoryLoading(false);
    }
  }, [filters]);

  const toggleHistory = async () => {
    if (historyOpen) return setHistoryOpen(false);
    setHistoryOpen(true);
    if (!historyLoaded) await loadTransactions(1, filters);
  };

  const submitFilters = async (event) => {
    event.preventDefault();
    const next = { ...draftFilters };
    setFilters(next);
    await loadTransactions(1, next);
  };

  const resetFilters = async () => {
    const next = { ...EMPTY_FILTERS };
    setDraftFilters(next);
    setFilters(next);
    await loadTransactions(1, next);
  };

  const toggleOrder = async (id) => {
    if (expandedOrderId === id) return setExpandedOrderId(null);
    setExpandedOrderId(id);
    if (orderDetails[id]) return;
    setOrderLoadingId(id);
    setOrderError('');
    try {
      const detail = await prizeService.getUserOrder(id);
      setOrderDetails((current) => ({ ...current, [id]: detail }));
    } catch (err) {
      setOrderError(err.response?.data?.message || '订单详情加载失败');
    } finally {
      setOrderLoadingId(null);
    }
  };

  if (loading) return <div className="loading">正在加载个人资料...</div>;
  if (error || !user || !summary) return <div className="container"><div className="form-error">{error || '未找到用户'}</div></div>;

  return (
    <div className="container profile-page">
      <BackButton to="/" />
      <h1 className="page-title">我的个人资料</h1>

      <div className="card" style={{ maxWidth: '800px', margin: '0 auto 2rem' }}>
        <h2 className="card-title" style={{ borderBottom: '2px solid var(--theme-border-soft)', paddingBottom: '1rem', marginBottom: '1.5rem' }}>用户信息</h2>
        <div className="profile-user-grid">
          <div className="profile-user-stat"><span>👤 用户名</span><strong>{user.username}</strong></div>
          <div className="profile-user-stat"><span>📧 邮箱</span><strong>{user.email}</strong></div>
          <div className="profile-user-stat"><span>⭐ 积分</span><strong className="primary">{formatNumber(summary.points)}</strong></div>
          <div className="profile-user-stat"><span>🛡️ 角色</span><strong>{roleLabel(user.role)}</strong></div>
        </div>

        <BilibiliBinding userId={user.id} />

        <section className="profile-points-panel">
          <div className="profile-points-panel-header"><h3>积分来源</h3><span>当前钱包概览</span></div>
          <div className="profile-points-summary-grid">
            <div className="profile-point-stat profile-point-stat-primary"><span>可用积分</span><strong>{formatNumber(summary.points)}</strong></div>
            <div className="profile-point-stat"><span>投喂折算</span><strong>{formatNumber(summary.auto_points)}</strong></div>
            <div className={`profile-point-stat ${Number(summary.manual_points || 0) < 0 ? 'profile-point-stat-negative' : ''}`}><span>手动调整</span><strong>{formatNumber(summary.manual_points)}</strong></div>
            <div className="profile-point-stat"><span>导入积分</span><strong>{formatNumber(summary.import_points)}</strong></div>
            <div className="profile-point-stat profile-point-stat-negative"><span>兑换支出</span><strong>{formatNumber(summary.redemption_spent)}</strong></div>
            <div className="profile-point-stat"><span>待折算电池</span><strong>{formatNumber(summary.remainder_battery)}</strong></div>
          </div>

          <div className="profile-points-history">
            <div className="profile-points-history-header">
              <div><h3>积分变动明细</h3><p>按时间倒序显示，每页 {PAGE_SIZE} 条。</p></div>
              <div className="profile-points-history-actions">
                <span>{historyLoaded ? `共 ${formatNumber(pagination.total)} 条` : '尚未加载'}</span>
                <button type="button" className="btn btn-secondary" onClick={toggleHistory} disabled={historyLoading}>{historyOpen ? '收起明细' : '展开明细'}</button>
              </div>
            </div>
            {historyOpen && <>
              <form className="profile-point-filter-form" onSubmit={submitFilters}>
                <label>开始日期<input type="date" value={draftFilters.start_date} onChange={(e) => setDraftFilters({ ...draftFilters, start_date: e.target.value })} /></label>
                <label>结束日期<input type="date" value={draftFilters.end_date} onChange={(e) => setDraftFilters({ ...draftFilters, end_date: e.target.value })} /></label>
                <label>来源<select value={draftFilters.source} onChange={(e) => setDraftFilters({ ...draftFilters, source: e.target.value })}><option value="all">全部来源</option>{Object.entries(SOURCE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                <label>方向<select value={draftFilters.direction} onChange={(e) => setDraftFilters({ ...draftFilters, direction: e.target.value })}><option value="all">全部</option><option value="income">加分</option><option value="expense">扣分</option></select></label>
                <label className="profile-point-filter-keyword">关键词<input type="search" value={draftFilters.keyword} onChange={(e) => setDraftFilters({ ...draftFilters, keyword: e.target.value })} placeholder="UID / 昵称 / 原因" /></label>
                <div className="profile-point-filter-actions"><button className="btn btn-primary" disabled={historyLoading}>筛选</button><button type="button" className="btn btn-secondary" onClick={resetFilters} disabled={historyLoading}>清空</button></div>
              </form>
              {historyError && <div className="form-error profile-point-error">{historyError}</div>}
              {historyLoading ? <div className="empty-state profile-point-empty"><p>正在加载积分明细...</p></div> : transactions.length === 0 ? <div className="empty-state profile-point-empty"><p>暂无匹配的积分变动明细</p></div> : <>
                <div className="profile-point-ledger">{transactions.map((tx) => {
                  const delta = Number(tx.points_delta || 0);
                  return <article className="profile-point-transaction" key={tx.id}>
                    <div className="profile-point-transaction-main"><div><strong>{SOURCE_LABELS[tx.source] || tx.source}</strong><span>{formatDate(tx.created_at)}</span></div><div className={`profile-point-delta ${delta >= 0 ? 'gain' : 'spend'}`}>{delta >= 0 ? '+' : ''}{formatNumber(delta)}</div></div>
                    <div className="profile-point-transaction-account">{[tx.bilibili_uname, tx.bilibili_uid ? `UID ${tx.bilibili_uid}` : ''].filter(Boolean).join(' / ') || '-'}</div>
                    <div className="profile-point-transaction-meta"><span>余额 {formatNumber(tx.balance_before)} 到 {formatNumber(tx.balance_after)}</span>{tx.reason && <span>{tx.reason}</span>}</div>
                  </article>;
                })}</div>
                <div className="profile-point-pagination"><span>第 {pagination.page || 1} / {pagination.totalPages || 1} 页</span><div><button className="btn btn-secondary" disabled={historyLoading || pagination.page <= 1} onClick={() => loadTransactions(pagination.page - 1, filters)}>上一页</button><button className="btn btn-secondary" disabled={historyLoading || pagination.page >= pagination.totalPages} onClick={() => loadTransactions(pagination.page + 1, filters)}>下一页</button></div></div>
              </>}
            </>}
          </div>
        </section>
      </div>

      <section className="profile-order-history">
        <div className="profile-order-history-header"><div><h2>兑换历史</h2><p>按订单查看兑换项目、备注和收货信息。</p></div><span>共 {orders.length} 个订单</span></div>
        {orderError && <div className="form-error profile-order-error">{orderError}</div>}
        {!orders.length ? <div className="empty-state"><div className="empty-state-icon">🎁</div><p>暂无兑换订单</p></div> : <div className="profile-order-list">{orders.map((order) => {
          const expanded = expandedOrderId === order.id;
          const detail = orderDetails[order.id];
          return <article key={order.id} className={`profile-order-card ${expanded ? 'expanded' : ''}`}>
            <button type="button" className="profile-order-summary" onClick={() => toggleOrder(order.id)}>
              <div className="profile-order-main"><strong>订单 #{order.id}</strong><span>{formatDate(order.created_at)}</span><small>{order.prize_names}</small></div>
              <div className="profile-order-meta"><span className={`profile-order-status ${order.status}`}>{statusLabel(order.status)}</span><span className={`profile-order-delivery ${Number(order.has_physical || 0) ? 'physical' : 'virtual'}`}>{orderDeliveryLabel(order)}</span></div>
              <div className="profile-order-total"><strong>{formatNumber(order.points_total)} 积分</strong><span>{order.line_count || 0} 个项目 · {order.item_count || 0} 件</span></div>
              <span className="profile-order-toggle">{expanded ? '收起' : '查看详情'}</span>
            </button>
            {expanded && <div className="profile-order-detail">{orderLoadingId === order.id ? <div className="empty-state profile-order-empty"><p>正在加载订单详情...</p></div> : detail ? <>
              <div className={`profile-order-address ${Number(detail.has_physical || 0) ? 'physical' : 'virtual'}`}><strong>{Number(detail.has_physical || 0) ? '收货地址' : '虚拟商品订单'}</strong><span>{Number(detail.has_physical || 0) ? (orderAddress(detail) || '没有地址快照') : '无需收货地址'}</span></div>
              <div className="profile-order-items">{(detail.items || []).map((item) => <div key={item.id} className="profile-order-item"><img src={imageUrl(item.prize_image)} alt={item.prize_name} /><div><strong>{item.prize_name}</strong><span>{item.option_name || '默认规格'} · x{item.quantity || 1}</span><span>{deliveryLabel(item.delivery_type)} · {formatNumber(item.points_cost)} 积分</span>{item.user_remark && <p>备注：{item.user_remark}</p>}</div><span className={`profile-order-status ${item.status}`}>{statusLabel(item.status)}</span></div>)}</div>
            </> : <div className="empty-state profile-order-empty"><p>订单详情暂不可用</p></div>}</div>}
          </article>;
        })}</div>}
      </section>
    </div>
  );
}

export default Profile;
