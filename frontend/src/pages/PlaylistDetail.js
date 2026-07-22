import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { playlistService } from '../services';
import BackButton from '../components/BackButton';

function PlaylistDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [playlist, setPlaylist] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadPlaylist = useCallback(async () => {
    try {
      const data = await playlistService.getPlaylistById(id);
      setPlaylist(data);
    } catch (err) {
      setError('Failed to load playlist');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadPlaylist();
  }, [loadPlaylist]);

  if (loading) {
    return <div className="loading">正在加载歌单...</div>;
  }

  if (error || !playlist) {
    return (
      <div className="container">
        <div className="form-error">{error || '未找到歌单'}</div>
        <button onClick={() => navigate('/playlists')} className="btn btn-primary">
          返回歌单列表
        </button>
      </div>
    );
  }

  return (
    <div className="container">
      <BackButton to="/playlists" />

      <div className="card" style={{ maxWidth: '800px', margin: '0 auto' }}>
        <img
          src={playlist.image_url || '/branding/chengzhi-sweety-logo.png'}
          alt={playlist.title}
          style={{ width: '100%', borderRadius: '8px', marginBottom: '1.5rem' }}
        />

        <h1 className="card-title">{playlist.title}</h1>
        <p className="card-description">{playlist.description}</p>
        <p style={{ color: 'var(--text-light)', fontSize: '0.875rem', marginBottom: '2rem' }}>
          By {playlist.creator_name || 'Unknown'}
        </p>

        <h2 style={{ color: 'var(--primary-purple)', marginBottom: '1rem' }}>
          歌曲 ({playlist.songs?.length || 0})
        </h2>

        {playlist.songs && playlist.songs.length > 0 ? (
          <div className="songs-grid">
            {playlist.songs.map((song, index) => (
              <div key={song.id} className="song-bubble">
                <div className="song-number">{index + 1}</div>
                <div className="song-bubble-content">
                  <h3 className="song-bubble-title">{song.title}</h3>
                  <p className="song-bubble-artist">
                    <span className="artist-icon">🎵</span> {song.artist}
                  </p>
                  <div className="song-meta">
                    <span className="song-genre">音乐</span>
                    {song.duration && <span className="song-time">{song.duration}</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <p>该歌单暂无歌曲</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default PlaylistDetail;
