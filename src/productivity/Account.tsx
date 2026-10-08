import { useState, useSyncExternalStore } from 'react';
import {
  cloudConfig,
  saveCloudConfig,
  passwordLogin,
  googleLogin,
  currentSession,
  cloudStatus,
  subscribeCloud,
  chooseAccount,
  signOut,
  syncNow,
  accountKey,
  deleteAccount,
} from './cloud';
import { confirmDestructive } from '../confirm';
import type { ProductivityData } from './model';

export default function Account({ data }: { data: ProductivityData }) {
  const status = useSyncExternalStore(subscribeCloud, cloudStatus);
  const session = currentSession();
  const [config, setConfig] = useState(cloudConfig);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [wipe, setWipe] = useState(false);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const needsChoice = session && data.syncOwner !== accountKey(session);
  return (
    <section className="p-settings-card">
      <h2>账号与同步</h2>
      <p className="p-muted">
        不登录也能使用所有本地功能。连接自己的同步服务后，任务、标签、日记和专注记录可在多台设备间同步。
      </p>
      <details>
        <summary>连接同步服务</summary>
        <label>
          服务地址
          <input
            type="url"
            placeholder="https://your-project.supabase.co"
            value={config.url}
            onChange={(e) => setConfig((c) => ({ ...c, url: e.target.value }))}
          />
        </label>
        <label>
          公开连接密钥
          <input
            type="password"
            autoComplete="off"
            placeholder="Publishable key / anon key"
            value={config.publishableKey}
            onChange={(e) =>
              setConfig((c) => ({ ...c, publishableKey: e.target.value }))
            }
          />
        </label>
        <button
          disabled={busy}
          onClick={() => void run(() => saveCloudConfig(config))}
        >
          保存连接配置
        </button>
        <p className="p-muted">
          仅填写公开密钥，服务端密钥不能保存在客户端。首次使用需部署随源码提供的同步服务。
        </p>
      </details>
      <p role="status" className="p-notice">
        {status}
      </p>
      {!session ? (
        <>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => passwordLogin(email, password));
            }}
          >
            <div className="p-setting-grid">
              <label>
                邮箱
                <input
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <label>
                密码
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  minLength={6}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
            </div>
            <div className="p-field-row">
              <button className="p-primary" disabled={busy}>
                登录
              </button>
              <button
                type="button"
                disabled={busy || !email || password.length < 6}
                onClick={() =>
                  void run(() => passwordLogin(email, password, true))
                }
              >
                注册账号
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => googleLogin())}
              >
                使用 Google 登录
              </button>
            </div>
          </form>
        </>
      ) : (
        <>
          <p>当前账号：{session.user.email ?? session.user.id}</p>
          {needsChoice ? (
            <div className="p-account-choice">
              <p>
                请选择这个账号的数据使用方式。选择前暂停同步，不会自动混合两个账号的数据。
              </p>
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    if (
                      await confirmDestructive(
                        '以此账号的云端数据替换本机任务、标签、日记和专注记录？本机独立日程保留。',
                        '载入云端',
                      )
                    )
                      await chooseAccount('cloud');
                  })
                }
              >
                载入此账号的云端数据
              </button>
              <button
                disabled={busy}
                onClick={() => void run(() => chooseAccount('copy'))}
              >
                复制本机数据到此账号（生成新 ID）
              </button>
            </div>
          ) : (
            <button
              className="p-primary"
              disabled={busy}
              onClick={() => void run(syncNow)}
            >
              立即同步
            </button>
          )}
          <button disabled={busy} onClick={() => void run(signOut)}>
            退出账号 / 切换账号
          </button>
          <h3>Google 日历</h3>
          <button
            disabled={busy}
            onClick={() => void run(() => googleLogin(true))}
          >
            授权 Google 日历
          </button>
          {(
            [
              'calendarEnabled',
              'calendarTimedOnly',
              'calendarKeepCompleted',
            ] as const
          ).map((key) => (
            <label className="p-inline-check" key={key}>
              <input
                type="checkbox"
                checked={config[key]}
                onChange={(e) => {
                  const next = { ...config, [key]: e.target.checked };
                  setConfig(next);
                  void run(() => saveCloudConfig(next));
                }}
              />
              {
                {
                  calendarEnabled: '将任务单向推送到「空核 · 任务」日历',
                  calendarTimedOnly: '只推送设置了提醒时间的任务',
                  calendarKeepCompleted: '在 Google 日历中保留已完成任务',
                }[key]
              }
            </label>
          ))}
          <p className="p-muted">
            独立日程只保存在本机。关闭同步不会删除已经创建的日历。
          </p>
          <details>
            <summary>注销账号</summary>
            <label className="p-inline-check">
              <input
                type="checkbox"
                checked={wipe}
                onChange={(e) => setWipe(e.target.checked)}
              />
              同时清空本机效率数据（包括独立日程）
            </label>
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  if (
                    await confirmDestructive(
                      '永久注销当前同步账号并删除全部云端效率数据？此操作无法撤销。',
                      '注销账号',
                    )
                  )
                    await deleteAccount(wipe);
                })
              }
            >
              永久注销账号
            </button>
          </details>
        </>
      )}
      {error && (
        <p className="p-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
