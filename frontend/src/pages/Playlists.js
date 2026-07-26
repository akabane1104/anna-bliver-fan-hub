import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import readXlsxFile from 'read-excel-file';
import { playlistService, authService, permissionService, songRequestService } from '../services';
import BackButton from '../components/BackButton';
import PublicSongQueue from '../components/PublicSongQueue';
import ViewerSongRequestPanel from '../components/ViewerSongRequestPanel';
import { useFeedback } from '../components/FeedbackProvider';
import { useSiteSettings } from '../context/SiteSettingsContext';
import {
  createIdempotencyKey,
  normalizeAvailability,
  normalizeSongRequestCenter,
  requestErrorMessage as songRequestErrorMessage
} from '../utils/songRequestUi';
import usePollingResource from '../utils/usePollingResource';

const requestErrorMessage = (fallback, error) => {
  const detail = error?.response?.data?.message;
  return detail ? `${fallback}：${detail}` : fallback;
};

const centerPollInterval = (data) => (
  data?.refreshAfterMs || data?.refresh_after_ms || 5000
);

function Playlists() {
  const { confirm, toast } = useFeedback();
  const { siteSettings } = useSiteSettings();
  const [allSongs, setAllSongs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [selectedTag, setSelectedTag] = useState('All');
  const [isSearching, setIsSearching] = useState(false);
  const [catalogTotal, setCatalogTotal] = useState(0);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);
  const [navbarHeight, setNavbarHeight] = useState(0);
  const searchContainerRef = useRef(null);
  const [visibleCount, setVisibleCount] = useState(50);

  // Edit mode states
  const [isEditMode, setIsEditMode] = useState(false);
  const [editingSong, setEditingSong] = useState(null);
  const [isAddingSong, setIsAddingSong] = useState(false);
  const [isBatchAdding, setIsBatchAdding] = useState(false);
  const [isManagingTags, setIsManagingTags] = useState(false);
  const [allTags, setAllTags] = useState([]);
  const [requestingSongIds, setRequestingSongIds] = useState(new Set());
  const [lastAcceptedRequest, setLastAcceptedRequest] = useState(null);
  const songRequestInFlight = useRef(new Set());
  const requestKeys = useRef(new Map());
  const viewerActionInFlight = useRef(new Set());
  const [viewerPending, setViewerPending] = useState('');
  const [viewerFilters, setViewerFilters] = useState({ status: '', page: 1, limit: 10 });

  const currentUser = useMemo(() => authService.getCurrentUser(), []);
  const authenticated = authService.isAuthenticated();
  const [canEdit, setCanEdit] = useState(false);
  const centerLoader = useCallback(
    ({ signal }) => songRequestService.getCenter({ signal }),
    []
  );
  const centerResource = usePollingResource(centerLoader, {
    intervalMs: centerPollInterval,
    staleAfterMs: 30000
  });
  const viewerLoader = useCallback(
    ({ signal }) => (
      authenticated
        ? songRequestService.getMine(viewerFilters, { signal })
        : Promise.resolve(null)
    ),
    [authenticated, viewerFilters]
  );
  const viewerResource = usePollingResource(viewerLoader, {
    intervalMs: 8000,
    staleAfterMs: 30000,
    autoRefresh: authenticated
  });
  const center = useMemo(
    () => normalizeSongRequestCenter(centerResource.data || {}),
    [centerResource.data]
  );
  const viewerBinding = viewerResource.data?.binding || {};
  const viewerBindingCount = Number(
    viewerBinding.count
    ?? viewerBinding.binding_count
    ?? viewerBinding.bindings?.length
    ?? 0
  );
  const viewerIsBound = Boolean(
    viewerBinding.bound
    ?? viewerBinding.is_bound
    ?? viewerBindingCount > 0
  );
// Get all unique tags from songs
  const availableTags = useMemo(
    () => ['All', ...new Set(allTags.map((tag) => tag.name))],
    [allTags]
  );

  const filteredSongs = allSongs;

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearchQuery(searchQuery.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  // Reset visibleCount when filters change
  useEffect(() => {
    setVisibleCount(50);
  }, [searchQuery, selectedTag]);

  useEffect(() => {
    const handleScroll = () => {
      if (window.scrollY > 300) {
        setShowScrollTop(true);
      } else {
        setShowScrollTop(false);
      }

      // Infinite scroll logic
      if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 500) {
        setVisibleCount(prev => {
          if (prev >= filteredSongs.length) return prev;
          return prev + 50;
        });
      }

      if (searchContainerRef.current) {
        const rect = searchContainerRef.current.getBoundingClientRect();
        // 吸附阈值：当元素顶部接触到导航栏底部时
        // 考虑到 sticky 的 top 设置为 navbarHeight
        const isStuck = rect.top <= navbarHeight + 17;

        setIsScrolled(prev => {
          // 如果当前未收缩，且已经吸附 -> 立即收缩
          if (!prev && isStuck) {
            return true;
          }
          // 如果当前已收缩，只有当向下脱离吸附点一定距离（滞后缓冲区）才展开
          // 这里设置 50px 的缓冲区，防止边缘抖动，实现“轻松脱离”但有阻尼
          if (prev && rect.top > navbarHeight + 150) {
            return false;
          }
          // 否则保持原状态
          return prev;
        });
      }
    };

    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, [navbarHeight, filteredSongs.length]);

  useEffect(() => {
    const updateNavbarHeight = () => {
      const navbar = document.querySelector('.navbar');
      if (navbar) {
        setNavbarHeight(navbar.offsetHeight);
      }
    };

    updateNavbarHeight();
    window.addEventListener('resize', updateNavbarHeight);
    return () => window.removeEventListener('resize', updateNavbarHeight);
  }, []);

  const loadTags = useCallback(async () => {
    try {
      const tags = await playlistService.getAllTags();
      setAllTags(tags);
    } catch (err) {
      console.error('Failed to load tags', err);
    }
  }, []);

  const loadSongs = useCallback(async () => {
    setIsSearching(true);
    try {
      const result = await songRequestService.getCatalog({
        query: debouncedSearchQuery,
        tag: selectedTag === 'All' ? '' : selectedTag,
        page: 1,
        limit: 500
      });
      const songs = result.songs || [];
      songs.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'zh-CN'));
      setAllSongs(songs);
      setCatalogTotal(result.pagination?.total || songs.length);
      setError('');
    } catch (err) {
      setError('加载歌曲列表失败');
    } finally {
      setLoading(false);
      setIsSearching(false);
    }
  }, [debouncedSearchQuery, selectedTag]);

  useEffect(() => {
    loadSongs();
  }, [loadSongs]);

  useEffect(() => {
    loadTags();
  }, [loadTags]);

  useEffect(() => {
    if (currentUser) {
      if (currentUser.role === 'admin') {
        setCanEdit(true);
      } else {
        permissionService.getMyPermissions().then(perms => {
          const hasEditPerm = perms.permissions?.includes(permissionService.PERMISSIONS.PLAYLIST_MANAGE);
          setCanEdit(hasEditPerm);
        }).catch(() => setCanEdit(false));
      }
    }
  }, [currentUser]);

  if (loading) {
    return <div className="loading">正在加载歌单...</div>;
  }

  if (error) {
    return <div className="container"><div className="form-error">{error}</div></div>;
  }

  const handleCopyToClipboard = (playlistTitle, customMessage = null) => {
    if (isEditMode) return; // Disable copy in edit mode
    const text = `点歌 ${playlistTitle}`;
    navigator.clipboard.writeText(text);
    toast(customMessage || '复制成功，去点歌吧！', { type: 'success' });
  };

  const handleRandomPick = () => {
    const songsToPickFrom = filteredSongs.length > 0 ? filteredSongs : allSongs;
    if (songsToPickFrom.length === 0) return;

    const randomIndex = Math.floor(Math.random() * songsToPickFrom.length);
    const randomSong = songsToPickFrom[randomIndex];

    handleCopyToClipboard(randomSong.title, `那就来听《${randomSong.title}》吧！`);
  };

  const handleSongRequest = async (event, song) => {
    event.stopPropagation();
    const availability = normalizeAvailability(song);
    if (
      !authenticated
      || !viewerIsBound
      || !center.effectiveOpen
      || !availability.requestable
      || songRequestInFlight.current.has(song.id)
    ) return;
    songRequestInFlight.current.add(song.id);
    const idempotencyKey = requestKeys.current.get(song.id) || createIdempotencyKey();
    requestKeys.current.set(song.id, idempotencyKey);
    setRequestingSongIds((current) => new Set(current).add(song.id));
    try {
      const result = await songRequestService.create(song.id, idempotencyKey);
      setLastAcceptedRequest(result.request);
      requestKeys.current.delete(song.id);
      toast(
        result.status === 'duplicate'
          ? `《${song.title}》已经在队列中`
          : `《${song.title}》已加入队列`,
        { type: 'success' }
      );
      await Promise.all([
        centerResource.refresh(),
        viewerResource.refresh(),
        loadSongs()
      ]);
    } catch (err) {
      toast(songRequestErrorMessage(err, '点歌'), { type: 'error' });
      if (err?.response?.status === 409) {
        await Promise.all([centerResource.refresh(), viewerResource.refresh(), loadSongs()]);
      }
    } finally {
      songRequestInFlight.current.delete(song.id);
      setRequestingSongIds((current) => {
        const next = new Set(current);
        next.delete(song.id);
        return next;
      });
    }
  };

  const runViewerAction = async (key, task) => {
    if (viewerActionInFlight.current.has(key)) return;
    viewerActionInFlight.current.add(key);
    setViewerPending(key);
    try {
      await task();
      await Promise.all([
        centerResource.refresh(),
        viewerResource.refresh(),
        loadSongs()
      ]);
    } catch (err) {
      toast(songRequestErrorMessage(err, '更新点歌'), { type: 'error' });
    } finally {
      viewerActionInFlight.current.delete(key);
      setViewerPending((current) => (current === key ? '' : current));
    }
  };

  const withdrawRequest = (request, revision) => {
    const publicId = request.publicId || request.public_id;
    return runViewerAction(
      `withdraw:${publicId}`,
      () => songRequestService.withdraw(publicId, revision)
    );
  };

  const rerequest = (request) => {
    const publicId = request.publicId || request.public_id;
    return runViewerAction(
      `rerequest:${publicId}`,
      () => songRequestService.rerequest(publicId, createIdempotencyKey())
    );
  };

  const handleEditClick = (e, song) => {
    e.stopPropagation();
    setEditingSong(song);
  };

  const handleSaveSong = async (updatedData) => {
    try {
      await playlistService.updateSong(editingSong.id, updatedData);
      setEditingSong(null);
      await loadSongs();
      toast('歌曲更新成功', { type: 'success' });
    } catch (err) {
      console.error('Failed to update song', err);
      toast(requestErrorMessage('更新歌曲失败', err), { type: 'error' });
      throw err;
    }
  };

  const handleDeleteSong = async (songId) => {
    const confirmed = await confirm({
      title: '删除歌曲',
      message: '确定要删除这首歌吗？',
      detail: '此操作无法撤销。',
      confirmText: '删除歌曲',
      variant: 'danger'
    });
    if (!confirmed) return;

    try {
      await playlistService.deleteSong(songId);
      setEditingSong(null);
      await loadSongs();
    } catch (err) {
      console.error('Failed to delete song', err);
      toast(requestErrorMessage('删除歌曲失败', err), { type: 'error' });
    }
  };

  const handleAddSong = async (newSongData) => {
    try {
      await playlistService.addSong(newSongData);
      setIsAddingSong(false);
      await Promise.all([loadSongs(), loadTags()]);
      toast('歌曲添加成功', { type: 'success' });
    } catch (err) {
      console.error('Failed to add song', err);
      toast(requestErrorMessage('添加歌曲失败', err), { type: 'error' });
      throw err;
    }
  };

  const handleBatchAddSongs = async (songs) => {
    try {
      const result = await playlistService.batchAddSongs(songs);
      toast(`成功添加 ${result.count} 首歌曲`, { type: 'success' });
      setIsBatchAdding(false);
      await Promise.all([loadSongs(), loadTags()]);
    } catch (err) {
      console.error('Failed to batch add songs', err);
      toast(requestErrorMessage('批量添加歌曲失败', err), { type: 'error' });
      throw err;
    }
  };

  const handleUpdateTag = async (tagId, tagData) => {
    try {
      await playlistService.updateTag(tagId, tagData);
      loadTags();
      loadSongs();
    } catch (err) {
      console.error('Failed to update tag', err);
      toast('更新标签失败', { type: 'error' });
    }
  };

  const handleDeleteTag = async (tagId) => {
    const confirmed = await confirm({
      title: '删除标签',
      message: '确定要删除这个标签吗？',
      detail: '这将从所有歌曲中移除此标签。',
      confirmText: '删除标签',
      variant: 'danger'
    });
    if (!confirmed) return;
    try {
      await playlistService.deleteTag(tagId);
      loadTags();
      loadSongs();
    } catch (err) {
      console.error('Failed to delete tag', err);
      toast('删除标签失败', { type: 'error' });
    }
  };

  const scrollToTop = () => {
    window.scrollTo({
      top: 0,
      behavior: 'smooth'
    });
  };

  return (
    <div className="container">
      <BackButton to="/" />

      <div className="playlist-header">
        <div>
          <h1 className="page-title" style={{ margin: 0 }}>{siteSettings.playlistTitle}</h1>
          <p className="page-subtitle">{siteSettings.playlistSubtitle}</p>
        </div>
        {canEdit && (
          <div className="playlist-admin-controls">
            {isEditMode && (
              <>
                <button
                  className="btn btn-primary"
                  style={{ borderRadius: '20px', padding: '8px 16px', fontSize: '0.9rem' }}
                  onClick={() => setIsAddingSong(true)}
                >
                  + 添加歌曲
                </button>
                <button
                  className="btn btn-secondary"
                  style={{ borderRadius: '20px', padding: '8px 16px', fontSize: '0.9rem' }}
                  onClick={() => setIsBatchAdding(true)}
                >
                  + 批量添加
                </button>
                <button
                  className="btn btn-secondary"
                  style={{ borderRadius: '20px', padding: '8px 16px', fontSize: '0.9rem' }}
                  onClick={() => setIsManagingTags(true)}
                >
                  # 管理标签
                </button>
              </>
            )}
            <button
              className={`edit-mode-btn ${isEditMode ? 'active' : ''}`}
              onClick={() => setIsEditMode(!isEditMode)}
            >
              {isEditMode ? '退出编辑' : '编辑模式'}
            </button>
          </div>
        )}
      </div>

      <PublicSongQueue
        data={centerResource.data}
        loading={centerResource.loading || centerResource.refreshing}
        error={centerResource.error ? songRequestErrorMessage(centerResource.error, '加载队列') : ''}
        onRetry={centerResource.refresh}
        lastAccepted={lastAcceptedRequest}
      />

      <ViewerSongRequestPanel
        authenticated={authenticated}
        data={viewerResource.data}
        loading={viewerResource.loading || viewerResource.refreshing}
        error={viewerResource.error ? songRequestErrorMessage(viewerResource.error, '加载我的点歌') : ''}
        filters={viewerFilters}
        onFiltersChange={setViewerFilters}
        onRefresh={viewerResource.refresh}
        onWithdraw={withdrawRequest}
        onRerequest={rerequest}
        pending={viewerPending}
      />

      {editingSong && (
        <EditSongModal
          song={editingSong}
          allTags={allTags}
          onSave={handleSaveSong}
          onDelete={() => handleDeleteSong(editingSong.id)}
          onCancel={() => setEditingSong(null)}
          title="编辑歌曲"
        />
      )}

      {isAddingSong && (
        <EditSongModal
          song={{ title: '', artist: '', duration: '', tags: [] }}
          allTags={allTags}
          onSave={handleAddSong}
          onCancel={() => setIsAddingSong(false)}
          title="添加新歌"
        />
      )}

      {isBatchAdding && (
        <BatchAddSongsModal
          allTags={allTags}
          onSave={handleBatchAddSongs}
          onCancel={() => setIsBatchAdding(false)}
        />
      )}

      {isManagingTags && (
        <TagManagerModal
          tags={allTags}
          onUpdate={handleUpdateTag}
          onDelete={handleDeleteTag}
          onCancel={() => setIsManagingTags(false)}
        />
      )}

      {allSongs.length === 0 && !debouncedSearchQuery && selectedTag === 'All' ? (
        <div className="empty-state">
          <div className="empty-state-icon">🎵</div>
          <p>暂无歌曲</p>
        </div>
      ) : (
        <div>
          <p style={{ color: 'var(--text-light)', marginBottom: '1rem', textAlign: 'center' }}>
            {debouncedSearchQuery || selectedTag !== 'All'
              ? `找到 ${catalogTotal} 首歌曲`
              : `总歌曲数: ${catalogTotal}`}
          </p>

          <div
            ref={searchContainerRef}
            className="search-filter-container"
            style={{
              transition: 'all 0.3s ease',
              padding: isScrolled ? '15px 1rem 0px' : '1rem',
              top: `${navbarHeight + 15}px`
            }}
          >
            <div className="playlist-search-row">
              <input
                type="search"
                placeholder="在此输入歌名或者歌手进行搜索..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="search-input"
                aria-label="搜索歌名、歌手或别名"
              />
              {(searchQuery || selectedTag !== 'All') && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    setSearchQuery('');
                    setSelectedTag('All');
                  }}
                >
                  清除筛选
                </button>
              )}
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleRandomPick}
                disabled={filteredSongs.length === 0}
              >
                随便听听
              </button>
            </div>
            {isSearching && <span className="playlist-searching" role="status">搜索中...</span>}

            {availableTags.length > 1 && (
              <div
                className="filter-tags"
                style={{
                  maxHeight: isScrolled ? '0' : '200px',
                  opacity: isScrolled ? 0 : 1,
                  overflow: 'hidden',
                  transition: 'all 0.3s ease',
                  marginTop: isScrolled ? 0 : '0.5rem'
                }}
              >
                {availableTags.map(tag => (
                  <button
                    key={tag}
                    className={`filter-tag-btn ${selectedTag === tag ? 'active' : ''}`}
                    onClick={() => setSelectedTag(tag)}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            )}
          </div>

          {filteredSongs.length === 0 && !isSearching ? (
            <div className="song-request-empty">
              <strong>没有找到符合条件的歌曲</strong>
              <span>可以清除搜索或分类后再试。</span>
            </div>
          ) : <div className="songs-grid">
            {filteredSongs.slice(0, visibleCount).map((song) => {
              const availability = normalizeAvailability(song);
              const requestDisabled = (
                !authenticated
                || !viewerIsBound
                || !center.effectiveOpen
                || !availability.requestable
                || requestingSongIds.has(song.id)
              );
              const requestLabel = requestingSongIds.has(song.id)
                ? '提交中...'
                : (!authenticated
                  ? '登录后点歌'
                  : (!viewerIsBound
                    ? '绑定后点歌'
                    : (!center.effectiveOpen
                      ? '暂未开放'
                      : (availability.requestable ? '点歌' : availability.reason))));
              return (
                <article key={song.id} className="song-bubble">
                  {song.note && (
                    <div className="song-note-badge">
                      <ScrollingText content={`冠名：${song.note}`} />
                    </div>
                  )}
                  <div className="song-bubble-content">
                    <div className="song-bubble-title">
                      <ScrollingText content={song.title} />
                    </div>
                    <div className="song-bottom-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '4px' }}>
                      <div className="song-bubble-artist" style={{ width: '100%' }}>
                        <ScrollingText content={song.artist} />
                      </div>
                      {song.tags && song.tags.length > 0 && (
                        <div className="song-tags" style={{ width: '100%', justifyContent: 'flex-start', marginLeft: 0, marginTop: 0 }}>
                          <ScrollingText
                            content={(
                              <div style={{ display: 'flex', gap: '4px' }}>
                                {song.tags.map((tag, i) => (
                                  <span
                                    key={i}
                                    className="song-tag"
                                    style={{ backgroundColor: tag.color || '#6c5ce7ff', whiteSpace: 'nowrap' }}
                                  >
                                    {tag.name}
                                  </span>
                                ))}
                              </div>
                            )}
                          />
                        </div>
                      )}
                      <div className="song-availability" aria-label={`《${song.title}》点歌状态`}>
                        {availability.sungToday && <span>今天已唱</span>}
                        {availability.cooldownUntil && <span>冷却中</span>}
                        {availability.alreadyQueued && <span>已在队列</span>}
                        {availability.temporarilyBlocked && <span>暂时不可点</span>}
                        {availability.specialEventOnly && <span>活动限定</span>}
                        {!availability.requestable && availability.reason && (
                          <small>{availability.reason}</small>
                        )}
                      </div>
                    </div>
                  </div>
                  {isEditMode ? (
                    <button
                      type="button"
                      className="song-edit-btn"
                      onClick={(event) => handleEditClick(event, song)}
                      aria-label={`编辑 ${song.title}`}
                    >
                      编辑
                    </button>
                  ) : (
                    <div className="song-card-actions">
                      <button
                        type="button"
                        className="song-copy-button"
                        onClick={() => handleCopyToClipboard(song.title)}
                        aria-label={`复制《${song.title}》点歌口令`}
                      >
                        复制口令
                      </button>
                      <button
                        type="button"
                        className="song-request-button"
                        onClick={(event) => handleSongRequest(event, song)}
                        disabled={requestDisabled}
                        aria-label={`${requestLabel} ${song.title}`}
                        title={requestLabel}
                      >
                        {requestLabel}
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>}
        </div>
      )}
      {showScrollTop && (
        <button
          className="back-to-top-btn"
          onClick={scrollToTop}
          title="回到顶部"
        >
          ↑
        </button>
      )}
    </div>
  );
}

const ScrollingText = ({ content, className, style }) => {
  const containerRef = useRef(null);
  const textRef = useRef(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [scrollAmount, setScrollAmount] = useState(0);

  useEffect(() => {
    const checkOverflow = () => {
      if (containerRef.current && textRef.current) {
        const containerWidth = containerRef.current.clientWidth;
        const textWidth = textRef.current.scrollWidth;
        const overflow = textWidth > containerWidth;
        setIsOverflowing(overflow);
        if (overflow) {
          setScrollAmount(textWidth - containerWidth);
        }
      }
    };

    checkOverflow();
    // Add a small delay to ensure fonts are loaded/layout is settled
    const timer = setTimeout(checkOverflow, 100);

    window.addEventListener('resize', checkOverflow);
    return () => {
      window.removeEventListener('resize', checkOverflow);
      clearTimeout(timer);
    };
  }, [content]);

  return (
    <div
      ref={containerRef}
      className={`scrolling-text-container ${isOverflowing ? 'is-overflowing' : ''} ${className || ''}`}
      style={{ ...style, '--scroll-amount': `${scrollAmount}px` }}
    >
      <div
        ref={textRef}
        className={`scrolling-text-content ${isOverflowing ? 'animate-bounce' : ''}`}
      >
        {content}
      </div>
    </div>
  );
};

function TagManagerModal({ tags, onUpdate, onDelete, onCancel }) {
  const [editingTagId, setEditingTagId] = useState(null);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState('');

  const startEditing = (tag) => {
    setEditingTagId(tag.id);
    setEditName(tag.name);
    setEditColor(tag.color || '#6c5ce7');
  };

  const handleSave = (id) => {
    onUpdate(id, { name: editName, color: editColor });
    setEditingTagId(null);
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: '500px' }}>
        <h3>管理标签</h3>
        <div style={{ maxHeight: '400px', overflowY: 'auto', margin: '1rem 0' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #eee' }}>
                <th style={{ textAlign: 'left', padding: '8px' }}>预览</th>
                <th style={{ textAlign: 'left', padding: '8px' }}>名称</th>
                <th style={{ textAlign: 'right', padding: '8px' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {tags.map(tag => (
                <tr key={tag.id} style={{ borderBottom: '1px solid #f5f5f5' }}>
                  <td style={{ padding: '8px' }}>
                    {editingTagId === tag.id ? (
                      <input
                        type="color"
                        value={editColor}
                        onChange={(e) => setEditColor(e.target.value)}
                        style={{ width: '30px', height: '30px', padding: 0, border: 'none', cursor: 'pointer' }}
                      />
                    ) : (
                      <span
                        style={{
                          display: 'inline-block',
                          width: '20px',
                          height: '20px',
                          backgroundColor: tag.color || '#6c5ce7',
                          borderRadius: '50%'
                        }}
                      />
                    )}
                  </td>
                  <td style={{ padding: '8px' }}>
                    {editingTagId === tag.id ? (
                      <input
                        type="text"
                        className="form-input"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        style={{ padding: '4px 8px' }}
                      />
                    ) : (
                      <span style={{ color: tag.color || '#6c5ce7', fontWeight: '500' }}>{tag.name}</span>
                    )}
                  </td>
                  <td style={{ padding: '8px', textAlign: 'right' }}>
                    {editingTagId === tag.id ? (
                      <div style={{ display: 'flex', gap: '5px', justifyContent: 'flex-end' }}>
                        <button
                          className="btn btn-primary"
                          style={{ padding: '4px 8px', fontSize: '0.8rem' }}
                          onClick={() => handleSave(tag.id)}
                        >
                          保存
                        </button>
                        <button
                          className="btn btn-secondary"
                          style={{ padding: '4px 8px', fontSize: '0.8rem' }}
                          onClick={() => setEditingTagId(null)}
                        >
                          取消
                        </button>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', gap: '5px', justifyContent: 'flex-end' }}>
                        <button
                          className="btn btn-secondary"
                          style={{ padding: '4px 8px', fontSize: '0.8rem' }}
                          onClick={() => startEditing(tag)}
                        >
                          编辑
                        </button>
                        <button
                          className="btn"
                          style={{ padding: '4px 8px', fontSize: '0.8rem', backgroundColor: '#ff4757', color: 'white', border: 'none' }}
                          onClick={() => onDelete(tag.id)}
                        >
                          删除
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="modal-actions">
          <button onClick={onCancel} className="btn btn-secondary">关闭</button>
        </div>
      </div>
    </div>
  );
}

function EditSongModal({ song, allTags, onSave, onDelete, onCancel, title }) {
  const { toast } = useFeedback();
  const submittingRef = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formData, setFormData] = useState({
    title: song.title,
    artist: song.artist,
    duration: song.duration || '',
    note: song.note || '',
    tags: song.tags || []
  });

  const [isCreatingTag, setIsCreatingTag] = useState(false);
  const [newTagData, setNewTagData] = useState({ name: '', color: '#6c5ce7' });
  const [localTags, setLocalTags] = useState(allTags);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setIsSubmitting(true);
    try {
      await onSave(formData);
    } catch (error) {
      // The parent keeps the modal open and shows the request error.
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  const toggleTag = (tag) => {
    const hasTag = formData.tags.some(t => t.name === tag.name);
    if (hasTag) {
      setFormData({
        ...formData,
        tags: formData.tags.filter(t => t.name !== tag.name)
      });
    } else {
      setFormData({
        ...formData,
        tags: [...formData.tags, tag]
      });
    }
  };

  const handleCreateTag = async () => {
    if (!newTagData.name) return;
    try {
      const newTag = await playlistService.createTag(newTagData);
      setLocalTags([...localTags, newTag]);
      // Automatically select the new tag
      setFormData({
        ...formData,
        tags: [...formData.tags, newTag]
      });
      setIsCreatingTag(false);
      setNewTagData({ name: '', color: '#6c5ce7' });
    } catch (err) {
      console.error('Failed to create tag', err);
      toast(`创建标签失败：${err.response?.data?.message || err.message}`, { type: 'error' });
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content">
        <h2>{title || '编辑歌曲'}</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">歌名</label>
            <input
              type="text"
              className="form-input"
              value={formData.title}
              onChange={e => setFormData({...formData, title: e.target.value})}
              required
            />
          </div>
          <div className="form-group">
            <label className="form-label">歌手</label>
            <input
              type="text"
              className="form-input"
              value={formData.artist}
              onChange={e => setFormData({...formData, artist: e.target.value})}
              required
            />
          </div>
          <div className="form-group">
            <label className="form-label">冠名</label>
            <input
              type="text"
              className="form-input"
              value={formData.note}
              onChange={e => setFormData({...formData, note: e.target.value})}
              placeholder="例如: XXX"
            />
          </div>
          <div className="form-group">
            <label className="form-label">标签</label>
            <div className="tags-selector">
              {localTags.map(tag => {
                const isSelected = formData.tags.some(t => t.name === tag.name);
                return (
                  <button
                    key={tag.id}
                    type="button"
                    className={`tag-select-btn ${isSelected ? 'selected' : ''}`}
                    style={{
                      backgroundColor: isSelected ? (tag.color || '#6c5ce7') : 'white',
                      color: isSelected ? 'white' : 'var(--text-dark)',
                      borderColor: tag.color || '#6c5ce7'
                    }}
                    onClick={() => toggleTag(tag)}
                  >
                    {tag.name}
                  </button>
                );
              })}
              <button
                type="button"
                className="tag-select-btn"
                style={{ borderStyle: 'dashed', color: 'var(--primary-purple)' }}
                onClick={() => setIsCreatingTag(!isCreatingTag)}
              >
                + 新建标签
              </button>
            </div>

            {isCreatingTag && (
              <div className="new-tag-form" style={{ marginTop: '1rem', padding: '1rem', background: '#f0f0f0', borderRadius: '8px' }}>
                <div style={{ display: 'flex', gap: '10px', marginBottom: '10px' }}>
                  <input
                    type="text"
                    placeholder="标签名称"
                    className="form-input"
                    value={newTagData.name}
                    onChange={e => setNewTagData({...newTagData, name: e.target.value})}
                  />
                  <input
                    type="color"
                    value={newTagData.color}
                    onChange={e => setNewTagData({...newTagData, color: e.target.value})}
                    style={{ height: '42px', width: '60px', padding: '0', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
                  />
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ padding: '6px 12px', fontSize: '0.9rem' }}
                  onClick={handleCreateTag}
                >
                  确认创建
                </button>
              </div>
            )}
          </div>
          <div className="modal-actions">
            {onDelete && (
              <button
                type="button"
                onClick={onDelete}
                className="btn"
                style={{ backgroundColor: '#ff4757', color: 'white', marginRight: 'auto' }}
              >
                删除
              </button>
            )}
            <button type="button" onClick={onCancel} className="btn btn-secondary" disabled={isSubmitting}>取消</button>
            <button type="submit" className="btn btn-primary" disabled={isSubmitting}>
              {isSubmitting ? '保存中…' : '保存'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function BatchAddSongsModal({ allTags, onSave, onCancel }) {
  const { toast } = useFeedback();
  const submittingRef = useRef(false);
  const [rows, setRows] = useState([{ title: '', artist: '', note: '', tags: [] }]);
  const [isUploading, setIsUploading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeTagRow, setActiveTagRow] = useState(null);
  const [newTagInput, setNewTagInput] = useState('');

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setIsUploading(true);
    try {
      const data = await readXlsxFile(file);

      if (data.length > 1) {
        const headers = data[0].map(h => h?.toString().toLowerCase().trim());
        const titleIdx = headers.findIndex(h => h === 'title' || h === '歌名');
        const artistIdx = headers.findIndex(h => h === 'artist' || h === '歌手');
        const noteIdx = headers.findIndex(h => h === 'note' || h === '冠名' || h === '备注');
        const tagsIdx = headers.findIndex(h => h === 'tags' || h === '标签');

        if (titleIdx === -1 || artistIdx === -1) {
          toast('Excel 必须包含 Title/歌名 和 Artist/歌手 列', { type: 'error' });
          setIsUploading(false);
          return;
        }

        const newRows = data.slice(1).map(row => {
          const tagStr = row[tagsIdx] || '';
          // Auto-match tags: split string and filter
          const tags = tagStr.toString().split(/[,，\s]+/).filter(Boolean);

          return {
            title: row[titleIdx]?.toString() || '',
            artist: row[artistIdx]?.toString() || '',
            note: row[noteIdx]?.toString() || '',
            tags: tags
          };
        }).filter(r => r.title && r.artist);

        if (newRows.length > 0) {
           setRows(prev => {
              const cleanPrev = prev.filter(r => r.title || r.artist);
              return [...cleanPrev, ...newRows];
           });
        }
      }
    } catch (err) {
      console.error(err);
      toast('解析 Excel 文件失败', { type: 'error' });
    } finally {
      setIsUploading(false);
    }
  };

  const handleRowChange = (index, field, value) => {
    const newRows = [...rows];
    newRows[index][field] = value;
    setRows(newRows);
  };

  const toggleTag = (rowIndex, tagName) => {
    const newRows = [...rows];
    const currentTags = newRows[rowIndex].tags || [];
    if (currentTags.includes(tagName)) {
      newRows[rowIndex].tags = currentTags.filter(t => t !== tagName);
    } else {
      newRows[rowIndex].tags = [...currentTags, tagName];
    }
    setRows(newRows);
  };

  const addNewTagToRow = (rowIndex) => {
    if (!newTagInput.trim()) return;
    const tagName = newTagInput.trim();
    const newRows = [...rows];
    const currentTags = newRows[rowIndex].tags || [];
    if (!currentTags.includes(tagName)) {
      newRows[rowIndex].tags = [...currentTags, tagName];
    }
    setRows(newRows);
    setNewTagInput('');
  };

  const addRow = () => {
    setRows([...rows, { title: '', artist: '', note: '', tags: [] }]);
  };

  const removeRow = (index) => {
    const newRows = rows.filter((_, i) => i !== index);
    if (newRows.length === 0) {
        setRows([{ title: '', artist: '', note: '', tags: [] }]);
    } else {
        setRows(newRows);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submittingRef.current) return;
    const validRows = rows.filter(r => r.title.trim() && r.artist.trim());
    if (validRows.length === 0) {
      toast('请至少添加一首有效歌曲', { type: 'warning' });
      return;
    }
    submittingRef.current = true;
    setIsSubmitting(true);
    try {
      await onSave(validRows);
    } catch (error) {
      // The parent keeps the modal open and shows the request error.
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: '1000px', width: '95%' }}>
        <h2>批量添加歌曲</h2>

        <div className="batch-actions" style={{ marginBottom: '1rem', display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <div className="file-upload">
            <label className="btn btn-secondary" style={{ cursor: 'pointer', display: 'inline-block' }}>
              📂 上传 Excel
              <input
                type="file"
                accept=".xlsx, .xls"
                onChange={handleFileUpload}
                disabled={isUploading || isSubmitting}
                style={{ display: 'none' }}
              />
            </label>
          </div>
          <span style={{ fontSize: '0.8rem', color: '#666' }}>
            支持格式: .xlsx, .xls (需包含表头: 歌名, 歌手, 冠名, 标签)
          </span>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="batch-table-container" style={{ maxHeight: '50vh', overflowY: 'auto', marginBottom: '1rem' }}>
            <table className="batch-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f8f9fa', textAlign: 'left' }}>
                  <th style={{ padding: '8px', width: '25%' }}>歌名 *</th>
                  <th style={{ padding: '8px', width: '20%' }}>歌手 *</th>
                  <th style={{ padding: '8px', width: '15%' }}>冠名</th>
                  <th style={{ padding: '8px', width: '35%' }}>标签</th>
                  <th style={{ padding: '8px', width: '50px' }}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={index} style={{ borderBottom: '1px solid #eee' }}>
                    <td style={{ padding: '8px' }}>
                      <input
                        className="form-input"
                        value={row.title}
                        onChange={e => handleRowChange(index, 'title', e.target.value)}
                        placeholder="歌名"
                        required
                      />
                    </td>
                    <td style={{ padding: '8px' }}>
                      <input
                        className="form-input"
                        value={row.artist}
                        onChange={e => handleRowChange(index, 'artist', e.target.value)}
                        placeholder="歌手"
                        required
                      />
                    </td>
                    <td style={{ padding: '8px' }}>
                      <input
                        className="form-input"
                        value={row.note}
                        onChange={e => handleRowChange(index, 'note', e.target.value)}
                        placeholder="冠名"
                      />
                    </td>
                    <td style={{ padding: '8px' }}>
                      <div
                        className="form-input"
                        style={{ minHeight: '38px', cursor: 'pointer', display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center' }}
                        onClick={() => setActiveTagRow(index)}
                      >
                        {row.tags && row.tags.length > 0 ? (
                          row.tags.map((tag, i) => {
                            const matchedTag = allTags.find(t => t.name === tag);
                            return (
                              <span
                                key={i}
                                style={{
                                  backgroundColor: matchedTag?.color || '#6c5ce7',
                                  color: 'white',
                                  padding: '2px 6px',
                                  borderRadius: '4px',
                                  fontSize: '0.8rem'
                                }}
                              >
                                {tag}
                              </span>
                            );
                          })
                        ) : (
                          <span style={{ color: '#999' }}>点击选择标签...</span>
                        )}
                      </div>
                    </td>
                    <td style={{ padding: '8px', textAlign: 'center' }}>
                      <button
                        type="button"
                        onClick={() => removeRow(index)}
                        style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#ff4757', fontSize: '1.2rem' }}
                        title="删除此行"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button
            type="button"
            onClick={addRow}
            className="btn btn-secondary"
            style={{ width: '100%', marginBottom: '1rem', borderStyle: 'dashed' }}
          >
            + 添加一行
          </button>

          <div className="modal-actions">
            <button type="button" onClick={onCancel} className="btn btn-secondary" disabled={isSubmitting}>取消</button>
            <button type="submit" className="btn btn-primary" disabled={isSubmitting || isUploading}>
              {isSubmitting ? '保存中…' : '保存全部'}
            </button>
          </div>
        </form>

        {/* Tag Selection Modal Overlay */}
        {activeTagRow !== null && (
          <div className="modal-overlay" style={{ zIndex: 1100, backgroundColor: 'rgba(0,0,0,0.3)' }}>
            <div className="modal-content" style={{ width: '500px', maxWidth: '90%' }}>
              <h3>选择标签: {rows[activeTagRow].title || '新歌曲'}</h3>

              <div className="tags-selector" style={{ maxHeight: '300px', overflowY: 'auto', marginBottom: '1rem' }}>
                {allTags.map(tag => {
                  const isSelected = rows[activeTagRow].tags?.includes(tag.name);
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      className={`tag-select-btn ${isSelected ? 'selected' : ''}`}
                      style={{
                        backgroundColor: isSelected ? (tag.color || '#6c5ce7') : 'white',
                        color: isSelected ? 'white' : 'var(--text-dark)',
                        borderColor: tag.color || '#6c5ce7'
                      }}
                      onClick={() => toggleTag(activeTagRow, tag.name)}
                    >
                      {tag.name}
                    </button>
                  );
                })}
              </div>

              <div style={{ display: 'flex', gap: '10px', marginTop: '1rem', borderTop: '1px solid #eee', paddingTop: '1rem' }}>
                <input
                  type="text"
                  className="form-input"
                  placeholder="输入新标签..."
                  value={newTagInput}
                  onChange={(e) => setNewTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addNewTagToRow(activeTagRow);
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => addNewTagToRow(activeTagRow)}
                >
                  添加
                </button>
              </div>

              <div className="modal-actions" style={{ marginTop: '1rem' }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    setActiveTagRow(null);
                    setNewTagInput('');
                  }}
                >
                  完成
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default Playlists;
