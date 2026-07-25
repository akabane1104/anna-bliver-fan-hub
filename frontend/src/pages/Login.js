import React, { useState, useRef } from 'react';
import { useNavigate, Link } from 'react-router';
import { authService } from '../services';
import BackButton from '../components/BackButton';
import AliyunCaptcha from '../components/AliyunCaptcha';

function Login() {
  const navigate = useNavigate();
  const [formData, setFormData] = useState({
    email: '',
    password: ''
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const captchaRef = useRef(null);

  const handleChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value
    });
    setError(''); // 清除错误
  };

  // 验证邮箱格式
  const isValidEmail = (email) => {
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    return emailRegex.test(email);
  };

  // 验证码验证成功后执行登录
  const handleCaptchaSuccess = async (captchaVerifyParam) => {
    // 前端验证
    if (!formData.email || !formData.password) {
      setError('请填写邮箱和密码');
      return false;
    }

    if (!isValidEmail(formData.email)) {
      setError('请输入有效的邮箱地址');
      return false;
    }

    setError('');
    setLoading(true);

    try {
      await authService.login(formData.email, formData.password, captchaVerifyParam);
      navigate('/');
      window.location.reload();
      return true;
    } catch (err) {
      const responseData = err.response?.data;
      // 如果是验证码验证失败，返回 { captchaResult: false } 让SDK自动弹出滑块
      if (responseData?.captchaFailed) {
        setLoading(false);
        return { captchaResult: false };
      }
      setError(responseData?.message || '登录失败');
      setLoading(false);
      // 刷新验证码
      if (captchaRef.current) {
        captchaRef.current.refresh();
      }
      return false;
    }
  };

  return (
    <div className="container">
      <BackButton to="/" />
      <div className="form-container">
        <h1 className="page-title" style={{ fontSize: '2rem' }}>登录</h1>
        <p style={{ textAlign: 'center', marginBottom: '2rem', color: 'var(--text-light)' }}>
          欢迎回来！请登录您的账号
        </p>

        <form onSubmit={(e) => e.preventDefault()}>
          <div className="form-group">
            <label className="form-label">邮箱</label>
            <input
              type="email"
              name="email"
              className="form-input"
              value={formData.email}
              onChange={handleChange}
              required
            />
            {formData.email && !isValidEmail(formData.email) && (
              <div style={{ color: '#e74c3c', fontSize: '0.85rem', marginTop: '4px' }}>
                请输入有效的邮箱地址
              </div>
            )}
          </div>

          <div className="form-group">
            <label className="form-label">密码</label>
            <input
              type="password"
              name="password"
              className="form-input"
              value={formData.password}
              onChange={handleChange}
              required
            />
          </div>

          {error && <div className="form-error" style={{ textAlign: 'center' }}>{error}</div>}

          <AliyunCaptcha
            ref={captchaRef}
            onSuccess={handleCaptchaSuccess}
            buttonText="登录"
            loadingText="登录中..."
            loading={loading}
            disabled={!formData.email || !formData.password || !isValidEmail(formData.email)}
            type="primary"
            style={{ width: '100%' }}
          />
        </form>

        <p style={{ textAlign: 'center', marginTop: '1rem', color: 'var(--text-light)' }}>
          还没有账号？ <Link to="/register" style={{ color: 'var(--primary-purple)' }}>注册</Link>
        </p>
      </div>
    </div>
  );
}

export default Login;
