import { useEffect, useState } from 'react';
import { ArrowSquareOut, CheckCircle, Copy, Eye, EyeSlash, X } from '@phosphor-icons/react';
import {
  DEV_PROFILE_URL,
  WechatError,
  getEgressIp,
  isConfigured,
  testConnection,
  type WechatConfig,
} from '../wechat';
import { patchWechatConfig, useWechatConfig } from '../store/wechatConfig';
import { getReaderKey, setReaderKey } from '../reader';
import { RELEASES_URL, appVersion, checkForUpdate, dismissVerdict, useUpdate } from '../store/updater';
import { getConfig, setConfig } from '../store/appConfig';
import { listApiModels, testApiAgent } from '../store/agent';

/** Where a free key comes from, for the one link in the 网页导入 section */
const READER_HOME = 'https://jina.ai/reader/';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Hand the conversation over to the update dialog once there is something
   *  to install — the release notes and the progress bar live there */
  onOpenUpdate: () => void;
}

/**
 * Account settings — the credentials, and the two probes that tell you whether
 * they work.
 *
 * This used to be a section inside the push dialog, which put it in the wrong
 * place twice over: you fill it in once and never look at it again, yet it sat
 * between "this article" and "publishing options" every single time; and it was
 * unreachable except by opening a dialog whose button says "push to drafts",
 * which is not where anyone looks for configuration.
 *
 * Everything here is account-level and lives in the app config directory, not
 * in the workspace — a workspace is a directory meant to be committed to git,
 * and an AppSecret in there is an AppSecret leaked.
 */
export default function SettingsDialog({ open, onClose, onOpenUpdate }: Props) {
  const cfg = useWechatConfig();
  const update = useUpdate();
  const [version, setVersion] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [apiBaseUrl, setApiBaseUrl] = useState(() => getConfig('agent.api.baseUrl') ?? 'https://api.openai.com/v1');
  const [apiKey, setApiKey] = useState(() => getConfig('agent.api.key') ?? '');
  const [apiModel, setApiModel] = useState(() => getConfig('agent.api.model') ?? '');
  const [apiModels, setApiModels] = useState<string[]>([]);
  const [apiModelsLoading, setApiModelsLoading] = useState(false);
  const [apiTesting, setApiTesting] = useState(false);
  const [apiProbe, setApiProbe] = useState<{ ok: boolean; message: string } | null>(null);
  /** Optional, and stored the moment it is typed — there is nothing to verify
   *  it against short of spending a request */
  const [readerKey, setKey] = useState(getReaderKey);
  const [busy, setBusy] = useState(false);
  /** Narrower than `busy`: only the connection self-check */
  const [testing, setTesting] = useState(false);
  const [probe, setProbe] = useState<{ kind: 'ok' | 'warn' | 'fail'; message: string } | null>(null);
  const [egress, setEgress] = useState<{ ip: string; stable: boolean } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void appVersion().then(setVersion);
  }, []);

  // Each visit starts from a clean slate: a verdict from last time says nothing
  // about the credentials as they are now
  useEffect(() => {
    if (open) {
      setProbe(null);
      setCopied(false);
      setShowSecret(false);
      setShowApiKey(false);
      setApiProbe(null);
      setApiModels([]);
      setApiBaseUrl(getConfig('agent.api.baseUrl') ?? 'https://api.openai.com/v1');
      setApiKey(getConfig('agent.api.key') ?? '');
      setApiModel(getConfig('agent.api.model') ?? '');
      setKey(getReaderKey());
      // Same for 已是最新 / 检查失败 — both are answers to a question asked
      // during some earlier visit
      dismissVerdict();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  /** Credentials changed: the cached token and the last verdict both expire
   *  (the token is dropped by the store itself). The egress IP stays — it is a
   *  property of this machine's connection, not of the account. */
  const patch = (p: Partial<WechatConfig>) => {
    setProbe(null);
    patchWechatConfig(p);
  };

  const runTest = async () => {
    setBusy(true);
    setTesting(true);
    setProbe(null);
    try {
      const check = await testConnection(cfg);
      // Lacking permission is not a "failure" — it is a verdict the user has to
      // act on, so it gets the warning color rather than the error one
      setProbe({ kind: check.canPublish ? 'ok' : 'warn', message: check.message });
    } catch (err) {
      // 40164 is the allow-list rejection, and WeChat names the IP it turned
      // away inside it. That is precisely the address that has to go on the
      // list, so it lands next to the copy button instead of making the user
      // go and fetch it a second time.
      if (err instanceof WechatError && err.errcode === 40164 && err.blockedIp) {
        setEgress({ ip: err.blockedIp, stable: true });
      }
      setProbe({ kind: 'fail', message: err instanceof Error ? err.message : '连接失败' });
    } finally {
      setBusy(false);
      setTesting(false);
    }
  };

  const runEgress = async () => {
    setBusy(true);
    try {
      setEgress(await getEgressIp(cfg));
    } catch (err) {
      setProbe({ kind: 'fail', message: err instanceof Error ? err.message : '拿不到出口 IP' });
    } finally {
      setBusy(false);
    }
  };

  const copyIp = async () => {
    if (!egress?.ip) return;
    try {
      await navigator.clipboard.writeText(egress.ip);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // If the copy fails, let the user select it themselves
    }
  };

  const saveApi = (key: string, value: string) => {
    setApiProbe(null);
    setConfig(key, value.trim());
  };

  const runApiTest = async () => {
    setApiTesting(true);
    setApiProbe(null);
    try {
      setApiProbe({ ok: true, message: await testApiAgent() });
    } catch (err) {
      setApiProbe({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setApiTesting(false);
    }
  };

  const loadApiModels = async () => {
    setApiModelsLoading(true);
    setApiProbe(null);
    try {
      const models = await listApiModels(apiBaseUrl, apiKey);
      setApiModels(models);
      if (!apiModel.trim() && models[0]) {
        setApiModel(models[0]);
        saveApi('agent.api.model', models[0]);
      }
      setApiProbe({ ok: true, message: `已获取 ${models.length} 个模型` });
    } catch (err) {
      setApiModels([]);
      setApiProbe({ ok: false, message: `${err instanceof Error ? err.message : String(err)}；仍可手动填写` });
    } finally {
      setApiModelsLoading(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onClose()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2>设置</h2>
          <button className="modal-close" onClick={onClose} disabled={busy} aria-label="关闭">
            <X size={15} weight="bold" />
          </button>
        </header>

        <div className="modal-body">
          <section className="form-section">
            <div className="form-section-label">API Agent</div>
            <p className="form-note">
              使用 OpenAI 兼容的 <code>Chat Completions</code> 接口。Agent 只获得当前工作区内的
              列出、搜索、读取和写入权限，不会启动本地终端。API Key 只保存在这台电脑上。
            </p>
            <label className="field">
              <span>Base URL</span>
              <input
                value={apiBaseUrl}
                onChange={(e) => {
                  setApiBaseUrl(e.target.value);
                  saveApi('agent.api.baseUrl', e.target.value);
                }}
                placeholder="https://api.openai.com/v1"
                spellCheck={false}
              />
            </label>
            <label className="field">
              <span>API Key</span>
              <span className="field-with-action">
                <input
                  type={showApiKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    saveApi('agent.api.key', e.target.value);
                  }}
                  onBlur={() => {
                    if (apiBaseUrl.trim() && apiKey.trim() && apiModels.length === 0) void loadApiModels();
                  }}
                  placeholder="sk-…"
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="field-action"
                  onClick={() => setShowApiKey((v) => !v)}
                  aria-label={showApiKey ? '隐藏' : '显示'}
                >
                  {showApiKey ? <EyeSlash size={15} /> : <Eye size={15} />}
                </button>
              </span>
            </label>
            <label className="field">
              <span>模型名</span>
              <input
                list="api-agent-models"
                value={apiModel}
                onChange={(e) => {
                  setApiModel(e.target.value);
                  saveApi('agent.api.model', e.target.value);
                }}
                placeholder="例如 gpt-5-mini"
                spellCheck={false}
              />
              <datalist id="api-agent-models">
                {apiModels.map((model) => <option key={model} value={model} />)}
              </datalist>
            </label>
            <div className="form-row">
              <button
                className="btn"
                onClick={() => void loadApiModels()}
                disabled={apiModelsLoading || !apiBaseUrl.trim() || !apiKey.trim()}
              >
                {apiModelsLoading ? '获取中…' : '获取模型'}
              </button>
              <button
                className="btn"
                onClick={() => void runApiTest()}
                disabled={apiTesting || !apiBaseUrl.trim() || !apiKey.trim() || !apiModel.trim()}
              >
                {apiTesting ? '测试中…' : '测试 API'}
              </button>
              {apiProbe && (
                <span className={apiProbe.ok ? 'form-ok' : 'form-error'}>
                  {apiProbe.ok && <CheckCircle size={13} weight="fill" />}
                  {apiProbe.message}
                </span>
              )}
            </div>
          </section>

          <section className="form-section">
            <div className="form-section-label">公众号凭据</div>
            <p className="form-note">
              在
              <a href={DEV_PROFILE_URL} target="_blank" rel="noopener noreferrer" className="ext-link">
                微信开发者控制台 <ArrowSquareOut size={11} weight="bold" />
              </a>
              的「我的业务 → 公众号」里取（AppID、AppSecret、IP 白名单都在这里）。
              只存在这台电脑上，请求直接发给微信，不过任何第三方。
            </p>
            <label className="field">
              <span>AppID</span>
              <input value={cfg.appid} onChange={(e) => patch({ appid: e.target.value.trim() })} placeholder="wx…" />
            </label>
            <label className="field">
              <span>AppSecret</span>
              <span className="field-with-action">
                <input
                  type={showSecret ? 'text' : 'password'}
                  value={cfg.secret}
                  onChange={(e) => patch({ secret: e.target.value.trim() })}
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  className="field-action"
                  onClick={() => setShowSecret((v) => !v)}
                  aria-label={showSecret ? '隐藏' : '显示'}
                >
                  {showSecret ? <EyeSlash size={15} /> : <Eye size={15} />}
                </button>
              </span>
            </label>
          </section>

          <section className="form-section">
            <div className="form-section-label">IP 白名单</div>
            <p className="form-note">
              这一步<strong>不能跳过</strong>：出口 IP 不在白名单里，微信一律拒绝（40164），凭据填得再对也调不通。
              取到下面这个 IP，粘进
              <a href={DEV_PROFILE_URL} target="_blank" rel="noopener noreferrer" className="ext-link">
                控制台 <ArrowSquareOut size={11} weight="bold" />
              </a>
              「我的业务 → 公众号」里的「IP 白名单」保存，才算配置完。
            </p>
            <div className="form-row">
              <button className="btn" onClick={() => void runEgress()} disabled={busy}>
                获取出口 IP
              </button>
              {egress && (
                <>
                  <code className="ip-badge">{egress.ip || '未知'}</code>
                  <button className="btn" onClick={() => void copyIp()}>
                    <Copy size={13} weight="bold" />
                    {copied ? '已复制' : '复制'}
                  </button>
                </>
              )}
            </div>
            {egress && (
              <p className="form-note">这是你本机的出口 IP。将这个 IP 复制配置到你的 IP 白名单即可。</p>
            )}
            {egress && !egress.stable && (
              <p className="form-warn">
                当前这个出口 IP <strong>会变</strong>，填进白名单也没用 —— 换成本机代理再取一次。
              </p>
            )}
          </section>

          {/* Optional, and last in the list on purpose: the feature works
              without any of this. The field exists for the one person who
              imports enough pages in a minute to hit the anonymous ceiling. */}
          <section className="form-section">
            <div className="form-section-label">网页导入</div>
            <p className="form-note">
              「从链接导入」的正文提取走
              <a href={READER_HOME} target="_blank" rel="noopener noreferrer" className="ext-link">
                Jina Reader <ArrowSquareOut size={11} weight="bold" />
              </a>
              —— 不填 key 也能用，每分钟 20 次。填一个免费 key 可以提到每分钟 500 次。
              这是本应用里唯一一处会经过第三方的请求，发过去的只有你要导入的那个网址。
            </p>
            <label className="field">
              <span>Jina API Key</span>
              <input
                type="password"
                value={readerKey}
                onChange={(e) => {
                  setKey(e.target.value);
                  setReaderKey(e.target.value);
                }}
                placeholder="可空，jina_…"
                spellCheck={false}
              />
            </label>
          </section>

          {/* Version, and the manual way to ask about a new one. The automatic
              check runs at launch and stays silent (see store/updater.ts), so
              this button is for the day you have heard a fix went out and do
              not want to wait six hours for the next poll. */}
          <section className="form-section">
            <div className="form-section-label">关于</div>
            <div className="update-line">
              <span className="app-version">空核编辑器 {version ? `v${version}` : ''}</span>
              <button
                className="btn"
                onClick={() => void checkForUpdate()}
                disabled={update.phase === 'checking' || update.phase === 'downloading'}
              >
                {update.phase === 'checking' ? '检查中…' : '检查更新'}
              </button>
            </div>

            {update.phase === 'current' && (
              <p className="form-ok">
                <CheckCircle size={13} weight="fill" />
                已经是最新版本。
              </p>
            )}

            {(update.phase === 'available' || update.phase === 'downloading' || update.phase === 'ready') && (
              <div className="form-row">
                <span className="form-progress">
                  {update.phase === 'ready'
                    ? `v${update.info.version} 已装好，重启即可生效`
                    : update.phase === 'downloading'
                      ? `正在下载 v${update.info.version}…`
                      : `发现新版本 v${update.info.version}`}
                </span>
                <button className="btn primary" onClick={onOpenUpdate}>
                  查看
                </button>
              </div>
            )}

            {update.phase === 'failed' && <p className="form-error">{update.message}</p>}

            <p className="form-note">
              更新包由构建时的签名密钥签过名，验不过的一律拒装。也可以直接去
              <a href={RELEASES_URL} target="_blank" rel="noopener noreferrer" className="ext-link">
                发布页 <ArrowSquareOut size={11} weight="bold" />
              </a>
              看历史版本。
            </p>
          </section>
        </div>

        <footer className="modal-foot">
          {probe && (
            <span className={probe.kind === 'ok' ? 'form-ok' : probe.kind === 'warn' ? 'form-caution' : 'form-error'}>
              {probe.kind === 'ok' && <CheckCircle size={13} weight="fill" />}
              {probe.message}
            </span>
          )}
          <button className="btn" onClick={() => void runTest()} disabled={busy || !isConfigured(cfg)}>
            {testing ? '检查中…' : '测试连接'}
          </button>
          <button className="btn primary" onClick={onClose} disabled={busy}>
            完成
          </button>
        </footer>
      </div>
    </div>
  );
}
