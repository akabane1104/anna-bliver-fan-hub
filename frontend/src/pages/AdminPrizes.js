import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { prizeService } from '../services';
import BackButton from '../components/BackButton';
import { useFeedback } from '../components/FeedbackProvider';
import AdminPrizeEditorModal from './AdminPrizeEditorModal';
import {
  IMAGE_ACCEPT,
  PrizeBasicFields,
  PrizeOptionsSummary,
  PrizeStatusFields,
  buildPrizePayload,
  createEmptyOption,
  formFromPrizeItem,
  getEmptyPrizeForm,
  getImageUrl,
  getUploadErrorMessage,
  prepareImageFile,
  validateImageFiles
} from './PrizeAdminForm';
import './AdminPrizes.css';

const rowsFrom = (response) => Array.isArray(response) ? response : response?.data || [];
const deliveryLabel = (type) => type === 'virtual' ? '虚拟商品' : '实体商品';
const primaryImage = (item) => item?.images?.[0]?.image_url || item?.image_url;

function formatItemCost(item) {
  const activeOptions = (item.options || []).filter((option) => option.is_active !== 0);
  if (!activeOptions.length) return `${Number(item.cost || 0).toLocaleString()} 积分`;
  const costs = activeOptions.map((option) => Number(option.cost ?? item.cost ?? 0));
  const min = Math.min(...costs);
  const max = Math.max(...costs);
  return `${min === max ? min : `${min}-${max}`} 积分`;
}

export default function AdminPrizes() {
  const { confirm } = useFeedback();
  const navigate = useNavigate();
  const location = useLocation();
  const { prizeId } = useParams();
  const routeWantsEditor = location.pathname.endsWith('/new') || Boolean(prizeId);
  const [items, setItems] = useState([]);
  const [selectedItem, setSelectedItem] = useState(null);
  const [form, setForm] = useState(getEmptyPrizeForm);
  const [editorState, setEditorState] = useState(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [togglingItemId, setTogglingItemId] = useState(null);
  const [pendingCreateImages, setPendingCreateImages] = useState([]);
  const [draggingItemId, setDraggingItemId] = useState(null);
  const [dragOverItemId, setDragOverItemId] = useState(null);
  const [savingOrder, setSavingOrder] = useState(false);
  const itemsRef = useRef([]);
  const dragSnapshotRef = useRef(null);
  const dropHandledRef = useRef(false);

  const loadItems = useCallback(async () => {
    const nextItems = rowsFrom(await prizeService.getAdminItems());
    setItems(nextItems);
    return nextItems;
  }, []);

  useEffect(() => { itemsRef.current = items; }, [items]);
  useEffect(() => {
    setLoading(true); setError('');
    loadItems().catch((err) => setError(err.response?.data?.message || '加载兑换后台失败')).finally(() => setLoading(false));
  }, [loadItems]);

  const totals = useMemo(() => items.reduce((result, item) => ({
    items: result.items + 1,
    active: result.active + (item.is_active ? 1 : 0),
    stock: result.stock + Number(item.available_stock ?? item.stock ?? 0),
    options: result.options + (item.options?.length || 0)
  }), { items: 0, active: 0, stock: 0, options: 0 }), [items]);

  const selectItem = (item) => {
    setSelectedItem(item);
    setForm(formFromPrizeItem(item));
    setPendingCreateImages([]);
    setMessage(''); setError('');
  };

  const startCreate = () => {
    setSelectedItem(null);
    setForm(getEmptyPrizeForm());
    setPendingCreateImages([]);
    setMessage(''); setError('');
  };

  const uploadPrizeFiles = async (targetPrizeId, files) => {
    for (const file of files) {
      const image = file.data_url ? file : await prepareImageFile(file);
      await prizeService.uploadPrizeImages(targetPrizeId, [{ url: image.data_url, alt_text: form.name || image.filename }]);
    }
  };

  const openFullEditor = (draft = form) => setEditorState({ prizeId: selectedItem?.id || null, draft });
  const openFullEditorWithNewOption = () => openFullEditor({ ...form, options: [...(form.options || []), createEmptyOption()] });
  const openEditorForItem = (item, event) => { event?.stopPropagation(); setEditorState({ prizeId: item.id, draft: null }); setMessage(''); setError(''); };
  const closeEditor = () => {
    setEditorState(null);
    if (routeWantsEditor) navigate('/admin/prizes', { replace: true, state: null });
  };

  const handleEditorSaved = async (savedItem, meta = {}) => {
    const nextItems = await loadItems();
    const refreshed = nextItems.find((item) => String(item.id) === String(savedItem.id)) || savedItem;
    setSelectedItem(refreshed);
    setForm(formFromPrizeItem(refreshed));
    setPendingCreateImages([]);
    if (!meta.imagesOnly) setMessage(meta.wasNew ? '礼物已创建' : '礼物已更新');
    if (meta.wasNew) {
      if (routeWantsEditor) navigate(`/admin/prizes/${refreshed.id}/edit`, { replace: true, state: null });
      else setEditorState({ prizeId: refreshed.id, draft: null });
    }
  };

  const handleEditorDeleted = async (deletedItem) => {
    await loadItems();
    if (selectedItem?.id === deletedItem.id) startCreate();
    closeEditor(); setMessage('礼物已删除');
  };

  const handleToggleItemActive = async (item, event) => {
    event?.stopPropagation(); setTogglingItemId(item.id); setError(''); setMessage('');
    try {
      await prizeService.updateAdminItem(item.id, buildPrizePayload({ ...formFromPrizeItem(item), is_active: !item.is_active }));
      const nextItems = await loadItems();
      const updated = nextItems.find((entry) => String(entry.id) === String(item.id));
      if (selectedItem?.id === item.id && updated) selectItem(updated);
      setMessage(updated?.is_active ? '礼物已上架' : '礼物已下架');
    } catch (err) { setError(err.response?.data?.message || '更新上下架状态失败'); }
    finally { setTogglingItemId(null); }
  };

  const handleSave = async (event) => {
    event.preventDefault(); setSaving(true); setMessage(''); setError('');
    try {
      const payload = buildPrizePayload(form);
      const response = await prizeService.createAdminItem(payload);
      const savedId = response.id || response.data?.id;
      if (pendingCreateImages.length) await uploadPrizeFiles(savedId, pendingCreateImages);
      const nextItems = await loadItems();
      const savedItem = nextItems.find((item) => String(item.id) === String(savedId));
      if (savedItem) selectItem(savedItem);
      setMessage('礼物已创建');
    } catch (err) { setError(getUploadErrorMessage(err) || '保存礼物失败'); }
    finally { setSaving(false); }
  };

  const handleDeleteItem = async (item) => {
    const confirmed = await confirm({ title: '删除礼物', message: `确定删除「${item.name}」吗？`, detail: '删除后用户兑换页和后台礼物列表都不会再显示它。', confirmText: '删除礼物', variant: 'danger' });
    if (!confirmed) return;
    try { await prizeService.deleteAdminItem(item.id); if (selectedItem?.id === item.id) startCreate(); await loadItems(); setMessage('礼物已删除'); }
    catch (err) { setError(err.response?.data?.message || '删除礼物失败'); }
  };

  const handleImageSelect = async (event) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;
    try {
      validateImageFiles(files);
      const images = await Promise.all(files.map(prepareImageFile));
      setPendingCreateImages((current) => [...current, ...images]);
    }
    catch (err) { setError(getUploadErrorMessage(err) || '读取图片失败'); }
    finally { event.target.value = ''; }
  };

  const handleItemDragStart = (event, itemId) => {
    setDraggingItemId(itemId); dragSnapshotRef.current = items; dropHandledRef.current = false;
    event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(itemId));
  };
  const handleItemDragEnter = (targetItemId) => {
    if (!draggingItemId || draggingItemId === targetItemId || dragOverItemId === targetItemId) return;
    setDragOverItemId(targetItemId);
    setItems((current) => {
      const from = current.findIndex((item) => item.id === draggingItemId);
      const to = current.findIndex((item) => item.id === targetItemId);
      if (from < 0 || to < 0) return current;
      const next = [...current]; const [moved] = next.splice(from, 1); next.splice(to, 0, moved); itemsRef.current = next; return next;
    });
  };
  const handleItemDrop = async (event) => {
    event.preventDefault(); dropHandledRef.current = true; setDraggingItemId(null); setDragOverItemId(null); setSavingOrder(true); setError('');
    try { await prizeService.updateAdminItemOrder(itemsRef.current.map((item) => item.id)); await loadItems(); setMessage('礼物排序已保存'); }
    catch (err) { setError(err.response?.data?.message || '保存礼物排序失败'); await loadItems(); }
    finally { setSavingOrder(false); dragSnapshotRef.current = null; }
  };
  const handleItemDragEnd = () => {
    if (!dropHandledRef.current && dragSnapshotRef.current) setItems(dragSnapshotRef.current);
    setDraggingItemId(null); setDragOverItemId(null); dragSnapshotRef.current = null; dropHandledRef.current = false;
  };

  const activeEditor = editorState || (routeWantsEditor ? { prizeId: prizeId || null, draft: location.state?.draft || null } : null);
  if (loading) return <div className="loading">正在加载礼物后台...</div>;

  return <div className="admin-prizes">
    <BackButton to="/" />
    <header className="admin-prizes-header"><div><h1>兑换礼物管理</h1><p>维护礼物、多图展示、积分价格、库存和子选项；订单处理在独立页面完成。</p></div><div className="admin-prizes-tabs"><button className="active">礼物</button><button type="button" onClick={() => navigate('/admin/prize-orders')}>订单管理</button></div></header>
    {message && <div className="prizes-success">{message}</div>}{error && <div className="prizes-error">{error}</div>}
    <section className="prizes-metrics"><div><span>礼物数</span><strong>{totals.items}</strong></div><div><span>上架中</span><strong>{totals.active}</strong></div><div><span>总库存</span><strong>{totals.stock}</strong></div><div><span>子选项</span><strong>{totals.options}</strong></div></section>

    <main className="admin-prizes-layout">
      <section className="prize-items-panel">
        <div className="panel-toolbar"><span className="panel-title-hint">拖动排序</span><h2>礼物列表</h2><button className="secondary-action" onClick={startCreate}>新建礼物</button></div>
        <div className="prize-admin-list">{items.map((item) => <div key={item.id} role="button" tabIndex={0} draggable={!savingOrder} className={`prize-admin-row ${selectedItem?.id === item.id ? 'selected' : ''} ${draggingItemId === item.id ? 'dragging' : ''}`} onDragStart={(event) => handleItemDragStart(event, item.id)} onDragOver={(event) => event.preventDefault()} onDragEnter={() => handleItemDragEnter(item.id)} onDrop={handleItemDrop} onDragEnd={handleItemDragEnd} onClick={() => selectItem(item)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectItem(item); } }}>
          <span className="drag-handle" aria-hidden="true">⋮⋮</span><img src={getImageUrl(primaryImage(item))} alt={item.name} /><div className="prize-row-main"><div className="prize-row-title-line"><span className={`status-pill ${item.is_active ? 'active' : 'inactive'}`}>{item.is_active ? '上架' : '下架'}</span><strong>{item.name}</strong></div><span><em className={`delivery-badge ${item.delivery_type === 'virtual' ? 'virtual' : 'physical'}`}>{deliveryLabel(item.delivery_type)}</em>{formatItemCost(item)} · 库存 {item.available_stock ?? item.stock}{item.options?.length ? ` · ${item.options.length} 个选项` : ''}</span></div>
          <div className="prize-row-actions" onClick={(event) => event.stopPropagation()}><button type="button" className="secondary-action compact-action" onClick={(event) => openEditorForItem(item, event)}>编辑</button><button type="button" className={item.is_active ? 'danger-action compact-action' : 'primary-action compact-action'} disabled={togglingItemId === item.id} onClick={(event) => handleToggleItemActive(item, event)}>{togglingItemId === item.id ? '处理中...' : item.is_active ? '下架' : '上架'}</button></div>
        </div>)}</div>
        {!items.length && <div className="empty-inline">暂无礼物，先在右侧创建第一个礼物。</div>}
      </section>

      <section className="prize-editor-panel prize-side-panel">
        {selectedItem ? <div className="prize-preview-panel">
          <div className="panel-toolbar"><div><h2>礼物预览</h2><p>点击编辑进入完整配置弹窗。</p></div><button type="button" className="secondary-action" onClick={startCreate}>新建礼物</button></div>
          <div className="prize-preview-card"><img src={getImageUrl(primaryImage(selectedItem))} alt={selectedItem.name} /><div className="prize-preview-main"><div className="prize-preview-title"><span className={`status-pill ${selectedItem.is_active ? 'active' : 'inactive'}`}>{selectedItem.is_active ? '上架' : '下架'}</span><h3>{selectedItem.name}</h3></div><span className={`delivery-badge ${selectedItem.delivery_type === 'virtual' ? 'virtual' : 'physical'}`}>{deliveryLabel(selectedItem.delivery_type)}</span><p>{selectedItem.description || '暂无描述'}</p></div></div>
          <div className="prize-preview-stats"><div><span>价格</span><strong>{formatItemCost(selectedItem)}</strong></div><div><span>库存</span><strong>{selectedItem.available_stock ?? selectedItem.stock}</strong></div><div><span>子选项</span><strong>{selectedItem.options?.length || 0}</strong></div><div><span>图片</span><strong>{selectedItem.images?.length || 0}</strong></div></div>
          {!!selectedItem.options?.length && <div className="prize-preview-options">{selectedItem.options.slice(0, 6).map((option) => <span key={option.id || option.name}>{option.name || '未命名选项'} · 库存 {option.stock || 0}</span>)}</div>}
          <div className="prize-preview-actions"><button type="button" className="primary-action" onClick={(event) => openEditorForItem(selectedItem, event)}>编辑</button><button type="button" className={selectedItem.is_active ? 'danger-action' : 'primary-action'} onClick={(event) => handleToggleItemActive(selectedItem, event)}>{selectedItem.is_active ? '下架' : '上架'}</button><button type="button" className="danger-action" onClick={() => handleDeleteItem(selectedItem)}>删除</button></div>
        </div> : <>
          <div className="panel-toolbar"><div><h2>新建礼物</h2><p>适合快速创建简单商品；复杂规格请进入完整新建。</p></div><button type="button" className="secondary-action" onClick={() => openFullEditor()}>完整新建</button></div>
          <form onSubmit={handleSave} className="prize-editor-form"><PrizeBasicFields form={form} setForm={setForm} /><PrizeOptionsSummary form={form} onOpenFullEditor={() => openFullEditor()} onAddOption={openFullEditorWithNewOption} /><PrizeStatusFields form={form} setForm={setForm} />
            <label className="file-button wide-file-button">选择礼物图片<input type="file" accept={IMAGE_ACCEPT} multiple onChange={handleImageSelect} /></label>
            {!!pendingCreateImages.length && <div className="pending-image-list">{pendingCreateImages.map((image, index) => <span key={`${image.filename}-${index}`}>{image.filename || `图片 ${index + 1}`}<button type="button" onClick={() => setPendingCreateImages((current) => current.filter((_, itemIndex) => itemIndex !== index))}>移除</button></span>)}</div>}
            <button className="primary-action" disabled={saving}>{saving ? '保存中...' : '保存礼物'}</button>
          </form>
        </>}
      </section>
    </main>

    {activeEditor && <AdminPrizeEditorModal prizeId={activeEditor.prizeId} draft={activeEditor.draft} items={items} onClose={closeEditor} onSaved={handleEditorSaved} onDeleted={handleEditorDeleted} />}
  </div>;
}
