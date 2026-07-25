import React, { useState, useEffect, useRef } from 'react';
import { marshmallowService, authService } from '../services';
import { useNavigate } from 'react-router';
import BackButton from '../components/BackButton';
import AliyunCaptcha from '../components/AliyunCaptcha';
import '../styles/App.css';

const MarshmallowWrite = () => {
  const [user, setUser] = useState(null);
  const [formData, setFormData] = useState({
    title: '',
    sender_alias: '',
    content: ''
  });
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState({ type: '', text: '' });
  const [submittedId, setSubmittedId] = useState(null);
  const [copySuccess, setCopySuccess] = useState(false);
  const captchaRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    const currentUser = authService.getCurrentUser();
    setUser(currentUser);
  }, []);

  const handleCopyId = () => {
    if (submittedId) {
      navigator.clipboard.writeText(submittedId);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    }
  };

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData({ ...formData, [name]: value });
    setMessage({ type: '', text: '' });
  };

  // 发送棉花糖 - 验证码验证成功后自动调用（未登录用户）
  const handleSubmitWithCaptcha = async (captchaVerifyParam) => {
    if (!formData.content) {
      setMessage({ type: 'error', text: '请填写内容' });
      return false;
    }

    setLoading(true);
    setMessage({ type: '', text: '' });
    setSubmittedId(null);

    try {
      const submitData = { ...formData, captchaVerifyParam };
      const response = await marshmallowService.createMarshmallow(submitData);
      setMessage({ type: 'success', text: '棉花糖发送成功！' });
      setFormData({ title: '', sender_alias: '', content: '' });
      setSubmittedId(response.id);
      return true;
    } catch (error) {
      const responseData = error.response?.data;
      // 如果是验证码验证失败，返回 { captchaResult: false } 让SDK自动弹出滑块
      if (responseData?.captchaFailed) {
        setLoading(false);
        return { captchaResult: false };
      }
      setMessage({ type: 'error', text: responseData?.message || '发送失败，请重试。' });
      if (captchaRef.current) {
        captchaRef.current.refresh();
      }
      return false;
    } finally {
      setLoading(false);
    }
  };

  // 登录用户直接提交
  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!formData.content) {
      setMessage({ type: 'error', text: '请填写内容' });
      return;
    }

    setLoading(true);
    setMessage({ type: '', text: '' });

    try {
      await marshmallowService.createMarshmallow(formData);
      setMessage({ type: 'success', text: '棉花糖发送成功！' });
      setFormData({ title: '', sender_alias: '', content: '' });
      setTimeout(() => {
        navigate('/marshmallows/my');
      }, 1500);
    } catch (error) {
      setMessage({ type: 'error', text: error.response?.data?.message || '发送失败，请重试。' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container">
      <BackButton to="/marshmallows" />
      <h1 className="page-title">写棉花糖</h1>
      <p className="page-subtitle">发送匿名消息，只有管理员可以看到哦~</p>

      <div className="form-container" style={{ marginTop: '0' }}>
        {message.text && (
          <div className={message.type === 'error' ? 'form-error' : 'form-success'} style={{ marginBottom: '1rem', textAlign: 'center' }}>
            {message.text}
          </div>
        )}

        {submittedId && (
          <div className="card" style={{ marginBottom: '1rem', background: '#e8f4f8', border: '1px solid #0e7c86' }}>
            <div style={{ color: '#0e7c86', fontWeight: 'bold', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
              您的棉花糖ID是:
              <span
                onClick={handleCopyId}
                style={{
                  background: '#fff',
                  padding: '4px 12px',
                  borderRadius: '20px',
                  border: '1px dashed #0e7c86',
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  transition: 'all 0.2s',
                  boxShadow: '0 2px 4px rgba(0,0,0,0.05)'
                }}
                title="点击复制"
                onMouseOver={(e) => e.currentTarget.style.background = '#f0fcfd'}
                onMouseOut={(e) => e.currentTarget.style.background = '#fff'}
              >
                {submittedId}
                <span style={{ fontSize: '1.2rem' }}>{copySuccess ? '✅' : '📋'}</span>
              </span>
              {copySuccess && <span style={{ fontSize: '0.8rem', color: '#27ae60', animation: 'fadeIn 0.3s' }}>已复制!</span>}
            </div>
            <p style={{ fontSize: '0.9rem' }}>
              请保存此ID，登录后可将其绑定到您的账户以查看回复。
            </p>
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">标题 (可选)</label>
            <input
              type="text"
              name="title"
              className="form-input"
              value={formData.title}
              onChange={handleInputChange}
              placeholder="给棉花糖起个标题吧"
            />
          </div>

          <div className="form-group">
            <label className="form-label">发件人昵称 (可选)</label>
            <input
              type="text"
              name="sender_alias"
              className="form-input"
              value={formData.sender_alias}
              onChange={handleInputChange}
              placeholder="你想叫什么名字？"
            />
          </div>

          <div className="form-group">
            <label className="form-label">内容 (必填)</label>
            <textarea
              name="content"
              className="form-input"
              value={formData.content}
              onChange={handleInputChange}
              placeholder="写下你想说的话..."
              rows="5"
              required
              style={{ resize: 'vertical', minHeight: '100px' }}
            ></textarea>
          </div>

          {/* 未登录用户：验证码与发送按钮集成 */}
          {!user ? (
            <AliyunCaptcha
              ref={captchaRef}
              onSuccess={handleSubmitWithCaptcha}
              buttonText="发送棉花糖"
              loadingText="发送中..."
              loading={loading}
              disabled={!formData.content}
              type="primary"
              style={{ width: '100%' }}
            />
          ) : (
            <button
              type="submit"
              className="btn btn-primary"
              style={{ width: '100%' }}
              disabled={loading || !formData.content}
            >
              {loading ? '发送中...' : '发送棉花糖'}
            </button>
          )}
        </form>
      </div>
    </div>
  );
};

export default MarshmallowWrite;
