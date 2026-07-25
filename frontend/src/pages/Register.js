import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, Link } from 'react-router';
import { authService, settingsService } from '../services';
import BackButton from '../components/BackButton';
import AliyunCaptcha from '../components/AliyunCaptcha';

function Register() {
  const navigate = useNavigate();
  const [formData, setFormData] = useState({
    username: '',
    email: '',
    password: '',
    confirmPassword: '',
    verificationCode: ''
  });
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const [registrationOpen, setRegistrationOpen] = useState(true);
  const [emailVerificationEnabled, setEmailVerificationEnabled] = useState(true);
  const [checkingStatus, setCheckingStatus] = useState(true);
  const [sendingCode, setSendingCode] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const captchaRef = useRef(null);

  useEffect(() => {
    checkRegistrationStatus();
  }, []);

  // 倒计时效果
  useEffect(() => {
    if (countdown > 0) {
      const timer = setTimeout(() => setCountdown(countdown - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [countdown]);

  // 发送验证码 - 验证码验证成功后自动调用
  const handleSendCode = async (captchaVerifyParam) => {
    setError('');

    if (!validateEmail(formData.email)) {
      setError('请输入有效的邮箱地址');
      return false;
    }

    setSendingCode(true);
    try {
      await authService.sendVerificationCode(formData.email, formData.username, captchaVerifyParam);
      setCountdown(60);
      setSuccess('验证码已发送到您的邮箱');
      setTimeout(() => setSuccess(''), 3000);
      return true;
    } catch (err) {
      const responseData = err.response?.data;
      // 如果是验证码验证失败，返回 { captchaResult: false } 让SDK自动弹出滑块
      if (responseData?.captchaFailed) {
        setSendingCode(false);
        return { captchaResult: false };
      }
      setError(responseData?.message || '发送验证码失败');
      // 刷新验证码
      if (captchaRef.current) {
        captchaRef.current.refresh();
      }
      return false;
    } finally {
      setSendingCode(false);
    }
  };

  const checkRegistrationStatus = async () => {
    try {
      const data = await settingsService.getRegistrationStatus();
      setRegistrationOpen(data.registrationOpen);
      setEmailVerificationEnabled(data.emailVerificationEnabled !== false);
    } catch (err) {
      console.error('Failed to check registration status');
    } finally {
      setCheckingStatus(false);
    }
  };

  const handleChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value
    });
    setError('');
  };

  // 验证邮箱格式
  const validateEmail = (email) => {
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    return emailRegex.test(email);
  };

  // 验证用户名：3-20个字符，只允许字母、数字、下划线、中文
  const validateUsername = (username) => {
    if (username.length < 3 || username.length > 20) {
      return { valid: false, message: '用户名长度需要在3-20个字符之间' };
    }
    const usernameRegex = /^[a-zA-Z0-9_\u4e00-\u9fa5]+$/;
    if (!usernameRegex.test(username)) {
      return { valid: false, message: '用户名只能包含字母、数字、下划线和中文' };
    }
    return { valid: true };
  };

  // 验证密码：10-64个字符，至少包含两种字符类型
  const validatePassword = (password) => {
    if (password.length < 10 || password.length > 64) {
      return { valid: false, message: '密码长度需要在10-64个字符之间' };
    }
    let typeCount = 0;
    if (/[a-zA-Z]/.test(password)) typeCount++;
    if (/[0-9]/.test(password)) typeCount++;
    if (/[^a-zA-Z0-9]/.test(password)) typeCount++;
    if (typeCount < 2) {
      return { valid: false, message: '密码需要包含字母、数字、特殊符号中的至少两种' };
    }
    return { valid: true };
  };

  const submitRegistration = async (captchaVerifyParam) => {
    setError('');
    setSuccess('');

    // 验证用户名
    const usernameResult = validateUsername(formData.username);
    if (!usernameResult.valid) {
      setError(usernameResult.message);
      return false;
    }

    // 验证邮箱格式
    if (!validateEmail(formData.email)) {
      setError('请输入有效的邮箱地址');
      return false;
    }

    // 验证密码
    const passwordResult = validatePassword(formData.password);
    if (!passwordResult.valid) {
      setError(passwordResult.message);
      return false;
    }

    if (formData.password !== formData.confirmPassword) {
      setError('两次输入的密码不一致');
      return false;
    }

    if (emailVerificationEnabled && (!formData.verificationCode || formData.verificationCode.length !== 6)) {
      setError('请输入6位邮箱验证码');
      return false;
    }

    setLoading(true);
    try {
      await authService.register(
        formData.username,
        formData.email,
        formData.password,
        emailVerificationEnabled ? formData.verificationCode : undefined,
        captchaVerifyParam
      );
      setSuccess('注册成功！正在跳转到登录页面...');
      setTimeout(() => {
        navigate('/login');
      }, 2000);
      return true;
    } catch (err) {
      const responseData = err.response?.data;
      if (responseData?.captchaFailed) {
        if (captchaRef.current) captchaRef.current.refresh();
        return { captchaResult: false };
      }
      setError(responseData?.message || '注册失败');
      return false;
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (emailVerificationEnabled) submitRegistration();
  };

  if (checkingStatus) {
    return <div className="loading">正在检查注册状态...</div>;
  }

  if (!registrationOpen) {
    return (
      <div className="container">
        <div className="form-container" style={{ textAlign: 'center', padding: '3rem 2rem' }}>
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🚫</div>
          <h1 className="page-title" style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>注册已关闭</h1>
          <p style={{ color: 'var(--text-light)', marginBottom: '2rem' }}>
            当前暂不开放新用户注册，请稍后再试。
          </p>
          <Link to="/login" className="btn btn-primary">
            返回登录
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <BackButton to="/" />
      <div className="form-container">
        <h1 className="page-title" style={{ fontSize: '2rem' }}>注册</h1>
        <p style={{ textAlign: 'center', marginBottom: '2rem', color: 'var(--text-light)' }}>
          创建您的账号以开始使用
        </p>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">用户名</label>
            <input
              type="text"
              name="username"
              className="form-input"
              value={formData.username}
              onChange={handleChange}
              required
            />
            <small style={{ color: 'var(--text-light)', fontSize: '0.75rem', marginTop: '0.25rem', display: 'block' }}>
              3-20个字符，支持字母、数字、下划线和中文
            </small>
          </div>

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
            <small style={{ color: 'var(--text-light)', fontSize: '0.75rem', marginTop: '0.25rem', display: 'block' }}>
              请输入有效的邮箱地址
            </small>
          </div>

          {emailVerificationEnabled && (
            <div className="form-group">
              <label className="form-label">邮箱验证码</label>
              <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
                <input
                  type="text"
                  name="verificationCode"
                  className="form-input"
                  value={formData.verificationCode}
                  onChange={handleChange}
                  placeholder="请输入6位验证码"
                  maxLength={6}
                  style={{ flex: 1 }}
                  required
                />
                <AliyunCaptcha
                  ref={captchaRef}
                  onSuccess={handleSendCode}
                  buttonText={countdown > 0 ? `${countdown}秒后重试` : '获取验证码'}
                  loadingText="发送中..."
                  loading={sendingCode}
                  disabled={countdown > 0 || !formData.email}
                  type="secondary"
                  style={{ whiteSpace: 'nowrap', minWidth: '120px' }}
                />
              </div>
              <small style={{ color: 'var(--text-light)', fontSize: '0.75rem', marginTop: '0.25rem', display: 'block' }}>
                验证码10分钟内有效
              </small>
            </div>
          )}

          <div className="form-group">
            <label className="form-label">密码</label>
            <input
              type="password"
              name="password"
              className="form-input"
              value={formData.password}
              onChange={handleChange}
              minLength={10}
              maxLength={64}
              required
            />
            <small style={{ color: 'var(--text-light)', fontSize: '0.75rem', marginTop: '0.25rem', display: 'block' }}>
              10-64个字符，需包含字母、数字、特殊符号中的至少两种
            </small>
          </div>

          <div className="form-group">
            <label className="form-label">确认密码</label>
            <input
              type="password"
              name="confirmPassword"
              className="form-input"
              value={formData.confirmPassword}
              onChange={handleChange}
              minLength={10}
              maxLength={64}
              required
            />
          </div>

          {error && <div className="form-error">{error}</div>}
          {success && <div className="form-success">{success}</div>}

          {emailVerificationEnabled ? (
            <button type="submit" className="btn btn-primary" style={{ width: '100%' }} disabled={loading}>
              {loading ? '注册中...' : '注册'}
            </button>
          ) : (
            <AliyunCaptcha
              ref={captchaRef}
              onSuccess={submitRegistration}
              buttonText="注册"
              loadingText="注册中..."
              loading={loading}
              type="primary"
              style={{ width: '100%' }}
            />
          )}
        </form>

        <p style={{ textAlign: 'center', marginTop: '1rem', color: 'var(--text-light)' }}>
          已有账号？ <Link to="/login" style={{ color: 'var(--primary-purple)' }}>登录</Link>
        </p>
      </div>
    </div>
  );
}

export default Register;
