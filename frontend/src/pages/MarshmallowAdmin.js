import React, { useState, useEffect, useRef } from 'react';
import { marshmallowService } from '../services';
import html2canvas from 'html2canvas';
import BackButton from '../components/BackButton';
import { useFeedback } from '../components/FeedbackProvider';
import '../styles/App.css';
import './MarshmallowAdmin.css';

const MarshmallowAdmin = () => {
  const { confirm, toast } = useFeedback();
  const [marshmallows, setMarshmallows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [replyingId, setReplyingId] = useState(null);
  const [replyContent, setReplyContent] = useState('');
  const [expandedIds, setExpandedIds] = useState(new Set());
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [mode, setMode] = useState('view'); // 'view', 'export', 'delete'
  const cardRefs = useRef({});
  const exportRefs = useRef({});

  useEffect(() => {
    fetchMarshmallows();
  }, []);

  const fetchMarshmallows = async () => {
    try {
      const data = await marshmallowService.getAllMarshmallows();
      setMarshmallows(data);
    } catch (error) {
      console.error('Error fetching marshmallows:', error);
    } finally {
      setLoading(false);
    }
  };

  const enterMode = (newMode) => {
    setMode(newMode);
    setSelectedIds(new Set());
  };

  const cancelMode = () => {
    setMode('view');
    setSelectedIds(new Set());
  };

  const toggleExpand = async (id, isRead) => {
    // In selection mode, clicking the card toggles selection instead of expanding
    if (mode !== 'view') {
      toggleSelect(id);
      return;
    }

    const newExpandedIds = new Set(expandedIds);
    if (newExpandedIds.has(id)) {
      newExpandedIds.delete(id);
    } else {
      newExpandedIds.add(id);
      if (!isRead) {
        try {
          await marshmallowService.markAsRead(id);
          // Update local state to reflect read status
          setMarshmallows(prev => prev.map(m =>
            m.id === id ? { ...m, user_read_at: new Date().toISOString() } : m
          ));
        } catch (error) {
          console.error('Error marking as read:', error);
        }
      }
    }
    setExpandedIds(newExpandedIds);
  };

  const toggleSelect = (id) => {
    const newSelectedIds = new Set(selectedIds);
    if (newSelectedIds.has(id)) {
      newSelectedIds.delete(id);
    } else {
      newSelectedIds.add(id);
    }
    setSelectedIds(newSelectedIds);
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === marshmallows.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(marshmallows.map(m => m.id)));
    }
  };

  const handleReplyClick = (e, m) => {
    e.stopPropagation();
    setReplyingId(m.id);
    setReplyContent(m.reply_content || '');
  };

  const handleCancelReply = () => {
    setReplyingId(null);
    setReplyContent('');
  };

  const handleSubmitReply = async (id) => {
    try {
      await marshmallowService.replyMarshmallow(id, replyContent);
      setReplyingId(null);
      fetchMarshmallows();
    } catch (error) {
      console.error('Error replying:', error);
      toast('回复失败', { type: 'error' });
    }
  };

  const handlePublishToObs = async (event, id) => {
    event.stopPropagation();
    try {
      const randomPart = window.crypto?.randomUUID
        ? window.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      await marshmallowService.publishToObs(id, {
        displayDurationMs: 12000,
        idempotencyKey: `cotton-candy-${randomPart}`
      });
      toast('棉花糖已发送到 OBS', { type: 'success' });
    } catch (error) {
      toast(error.response?.data?.message || '发送到 OBS 失败', { type: 'error' });
    }
  };

  const handleConfirmAction = async () => {
    if (selectedIds.size === 0) return;

    if (mode === 'delete') {
      const confirmed = await confirm({
        title: '删除棉花糖',
        message: `确定要删除选中的 ${selectedIds.size} 个棉花糖吗？`,
        detail: '删除后将无法恢复。',
        confirmText: '删除',
        variant: 'danger'
      });
      if (!confirmed) return;

      try {
        await marshmallowService.deleteMarshmallows(Array.from(selectedIds));
        fetchMarshmallows();
        cancelMode();
      } catch (error) {
        console.error('Error deleting marshmallows:', error);
        toast('删除失败', { type: 'error' });
      }
    } else if (mode === 'export') {
      const idsToExport = Array.from(selectedIds);

      for (const id of idsToExport) {
        const element = exportRefs.current[id];
        if (element) {
          try {
            const canvas = await html2canvas(element, {
                backgroundColor: null,
                scale: 2,
                logging: false,
                useCORS: true
            });

            const link = document.createElement('a');
            link.download = `marshmallow-${id}.png`;
            link.href = canvas.toDataURL();
            link.click();
          } catch (err) {
            console.error(`Error exporting marshmallow ${id}:`, err);
          }
        }
      }
      cancelMode();
    }
  };

  if (loading) return <div className="loading">加载中...</div>;

  return (
    <div className="container marshmallow-admin-page">
      <BackButton to="/marshmallows" />
      <div className="marshmallow-admin-header">
        <h1 className="page-title" style={{ margin: 0 }}>棉花糖管理</h1>
        <div className="marshmallow-admin-actions">
          {mode === 'view' ? (
            <>
              <button
                className="btn btn-secondary"
                onClick={() => enterMode('export')}
              >
                批量导出
              </button>
              <button
                className="btn"
                style={{ background: 'var(--danger-color)', color: 'var(--white)' }}
                onClick={() => enterMode('delete')}
              >
                批量删除
              </button>
            </>
          ) : (
            <>
              <span className="marshmallow-selection-count">
                已选择: {selectedIds.size}
              </span>
              <button
                className="btn btn-primary"
                onClick={handleConfirmAction}
                disabled={selectedIds.size === 0}
                style={{ background: mode === 'delete' ? 'var(--danger-color)' : 'var(--primary-purple)' }}
              >
                {mode === 'delete' ? '确认删除' : '确认导出'}
              </button>
              <button
                className="btn btn-outline"
                onClick={cancelMode}
              >
                取消
              </button>
            </>
          )}
        </div>
      </div>

      {mode !== 'view' && (
        <div className="marshmallow-select-all">
          <label>
            <input
              type="checkbox"
              checked={selectedIds.size === marshmallows.length && marshmallows.length > 0}
              onChange={toggleSelectAll}
              style={{ width: '18px', height: '18px' }}
            />
            <span>全选</span>
          </label>
        </div>
      )}

      <div className="marshmallow-admin-list">
        {marshmallows.map((m) => {
          const isExpanded = expandedIds.has(m.id);
          const isRead = !!m.user_read_at;
          const isSelected = selectedIds.has(m.id);

          return (
            <div
              key={m.id}
              ref={el => cardRefs.current[m.id] = el}
              className={`card marshmallow-admin-card ${!isRead ? 'marshmallow-admin-card-unread' : ''} ${isSelected ? 'marshmallow-admin-card-selected' : ''}`}
              style={{
                borderLeft: m.reply_content ? '5px solid var(--success-color)' : '5px solid var(--danger-color)',
              }}
              onClick={() => toggleExpand(m.id, isRead)}
            >
              <div className="marshmallow-card-layout">
                {mode !== 'view' && (
                  <div className="marshmallow-card-checkbox" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelect(m.id)}
                      style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                    />
                  </div>
                )}

                <div className="marshmallow-card-main">
                  <div className="marshmallow-card-header">
                    <div className="marshmallow-card-title-block">
                      <div className="marshmallow-card-title-row">
                        {!isRead && <span className="marshmallow-new-badge">NEW</span>}
                        <h3 className="marshmallow-card-title">{m.title || '无标题'}</h3>
                      </div>
                      <div className="marshmallow-card-meta">
                        <span>ID: {m.id}</span>
                        <span>发件人: {m.sender_alias}</span>
                      </div>
                    </div>
                    <time className="marshmallow-card-time" dateTime={m.created_at}>
                      {new Date(m.created_at).toLocaleString()}
                    </time>
                  </div>

                  {!isExpanded && m.content && (
                    <p className="marshmallow-card-preview">{m.content}</p>
                  )}

                  {isExpanded && (
                    <div className="marshmallow-card-expanded" onClick={(e) => e.stopPropagation()}>
                      <p className="marshmallow-card-content">
                        {m.content}
                      </p>

                      {replyingId === m.id ? (
                        <div className="marshmallow-reply-editor">
                          <textarea
                            className="form-input"
                            value={replyContent}
                            onChange={(e) => setReplyContent(e.target.value)}
                            rows="4"
                            placeholder="输入回复内容..."
                          ></textarea>
                          <div className="marshmallow-reply-actions">
                            <button className="btn btn-primary" onClick={() => handleSubmitReply(m.id)}>发送回复</button>
                            <button className="btn btn-outline" onClick={handleCancelReply}>取消</button>
                          </div>
                        </div>
                      ) : (
                        <div>
                          {m.reply_content && (
                            <div className="marshmallow-reply-content">
                              <p className="marshmallow-reply-title">
                                回复 ({new Date(m.reply_at).toLocaleString()}):
                              </p>
                              <p>{m.reply_content}</p>
                            </div>
                          )}
                          <button className="btn btn-secondary" onClick={(e) => handleReplyClick(e, m)}>
                            {m.reply_content ? '修改回复' : '回复'}
                          </button>
                          <button
                            className="btn btn-outline"
                            onClick={(event) => handlePublishToObs(event, m.id)}
                          >
                            展示到 OBS
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Hidden Export Templates */}
      <div style={{ position: 'absolute', left: '-9999px', top: '-9999px' }}>
        {marshmallows.map((m) => (
          <div
            key={`export-${m.id}`}
            ref={el => exportRefs.current[m.id] = el}
            style={{
              width: '800px',
              padding: '60px',
              background: '#fff',
              fontFamily: '"Microsoft YaHei", sans-serif',
              color: '#333',
              position: 'relative',
              boxSizing: 'border-box'
            }}
          >
            {/* Decorative Header */}
            <div style={{
              borderBottom: '2px solid var(--primary-purple)',
              paddingBottom: '20px',
              marginBottom: '30px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-end'
            }}>
              <div>
                <div style={{ fontSize: '14px', color: '#666', marginBottom: '8px' }}>标题</div>
                <h1 style={{ margin: 0, fontSize: '24px', color: 'var(--primary-purple)' }}>{m.title || '无标题'}</h1>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: '14px', color: '#666', marginBottom: '4px' }}>发件人</div>
                <div style={{ fontSize: '18px', fontWeight: 'bold' }}>{m.sender_alias}</div>
              </div>
            </div>

            {/* Content Body */}
            <div style={{
              minHeight: '300px',
              fontSize: '18px',
              lineHeight: '1.8',
              whiteSpace: 'pre-wrap',
              marginBottom: '40px'
            }}>
              <div style={{ fontSize: '14px', color: '#666', marginBottom: '15px' }}>正文：</div>
              {m.content}
            </div>

            {/* Footer */}
            <div style={{
              borderTop: '1px solid #eee',
              paddingTop: '20px',
              display: 'flex',
              justifyContent: 'space-between',
              color: '#999',
              fontSize: '14px'
            }}>
              <div>ID: {m.id}</div>
              <div>{new Date(m.created_at).toLocaleString()}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default MarshmallowAdmin;
