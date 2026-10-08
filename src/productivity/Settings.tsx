import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Plus, Trash } from '@phosphor-icons/react';
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';
import {
  isPermissionGranted,
  requestPermission,
} from '@tauri-apps/plugin-notification';
import { useAppearance } from '../store/appearance';
import {
  uid,
  type ProductivityData,
  type Settings as SettingsRecord,
} from './model';
import { mutateProductivity } from './store';
import { confirmDestructive } from '../confirm';
import Account from './Account';

export function Labels({ data }: { data: ProductivityData }) {
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [color, setColor] = useState('#d97757');
  const [error, setError] = useState('');
  return (
    <section className="p-main-section">
      <header className="p-page-heading">
        <div>
          <div className="p-eyebrow">给不同的生活，一个颜色</div>
          <h1>标签</h1>
        </div>
      </header>
      <form
        className="p-field-row"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          try {
            await mutateProductivity((d) => {
              if (d.labels.some((l) => !l.deletedAt && l.name === name.trim()))
                throw new Error('同名标签已存在');
              d.labels.push({
                id: uid(),
                name: name.trim(),
                color,
                updatedAt: Date.now(),
              });
            });
            setName('');
            setError('');
          } catch (e) {
            setError(String(e));
          }
        }}
      >
        <input
          aria-label="新标签名称"
          placeholder="新标签，例如：生活、工作、学习"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          type="color"
          aria-label="新标签颜色"
          value={color}
          onChange={(e) => setColor(e.target.value)}
        />
        <button className="p-primary">
          <Plus size={18} />
          添加标签
        </button>
      </form>
      {error && (
        <p className="p-error" role="alert">
          {error}
        </p>
      )}
      <input
        aria-label="搜索标签"
        type="search"
        placeholder="搜索标签"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {data.labels
        .filter(
          (l) =>
            !l.deletedAt && l.name.toLowerCase().includes(query.toLowerCase()),
        )
        .map((l) => (
          <div className="p-label-row" key={l.id}>
            <input
              type="color"
              aria-label={`${l.name}的颜色`}
              value={l.color}
              onChange={(e) => {
                void mutateProductivity((d) => {
                  const row = d.labels.find((x) => x.id === l.id)!;
                  row.color = e.target.value;
                  row.updatedAt = Date.now();
                }).catch(() => {});
              }}
            />
            <input
              aria-label={`重命名标签 ${l.name}`}
              defaultValue={l.name}
              key={`${l.id}:${l.name}`}
              onBlur={(e) => {
                const name = e.target.value.trim();
                if (!name || name === l.name) {
                  e.target.value = l.name;
                  return;
                }
                void mutateProductivity((d) => {
                  if (
                    d.labels.some(
                      (x) => x.id !== l.id && !x.deletedAt && x.name === name,
                    )
                  )
                    throw new Error('同名标签已存在');
                  const row = d.labels.find((x) => x.id === l.id)!;
                  row.name = name;
                  row.updatedAt = Date.now();
                }).catch((e) => setError(String(e)));
              }}
            />
            <span className="p-muted">
              {
                data.tasks.filter(
                  (t) =>
                    !t.deletedAt && !t.completedAt && t.labels.includes(l.id),
                ).length
              }{' '}
              个任务
            </span>
            <button
              className="p-icon"
              aria-label={`删除标签 ${l.name}`}
              onClick={async () => {
                if (
                  await confirmDestructive(
                    `删除标签「${l.name}」？任务会保留。`,
                  )
                ) {
                  void mutateProductivity((d) => {
                    const row = d.labels.find((x) => x.id === l.id)!;
                    row.deletedAt = row.updatedAt = Date.now();
                    d.tasks
                      .filter((t) => t.labels.includes(l.id))
                      .forEach((t) => {
                        t.labels = t.labels.filter((id) => id !== l.id);
                        t.updatedAt = Date.now();
                      });
                  }).catch(() => {});
                }
              }}
            >
              <Trash size={18} />
            </button>
          </div>
        ))}
    </section>
  );
}
export default function Settings({ data }: { data: ProductivityData }) {
  const { appearance, setAppearance } = useAppearance();
  const [autostart, setAutostart] = useState(false);
  const [message, setMessage] = useState('');
  const native = '__TAURI_INTERNALS__' in window;
  useEffect(() => {
    if (native)
      void invoke<string[]>('productivity_desktop_status')
        .then((errors) => {
          if (errors.length) setMessage(errors.join('；'));
        })
        .catch((e) => setMessage(String(e)));
  }, [native]);
  useEffect(() => {
    if (native)
      void isEnabled()
        .then(setAutostart)
        .catch((e) => setMessage(String(e)));
  }, [native]);
  const set = (patch: Partial<SettingsRecord>) => {
    void mutateProductivity((d) => {
      Object.assign(d.settings, patch);
    }).catch(() => {});
  };
  const s = data.settings;
  return (
    <section className="p-main-section p-settings">
      <header className="p-page-heading">
        <div>
          <div className="p-eyebrow">按照自己的节奏</div>
          <h1>效率设置</h1>
        </div>
      </header>
      <section className="p-settings-card">
        <h2>专注与计时</h2>
        <div className="p-setting-grid">
          {(
            [
              'focusMinutes',
              'shortBreakMinutes',
              'longBreakMinutes',
              'longBreakEvery',
            ] as const
          ).map((key) => (
            <label key={key}>
              {
                {
                  focusMinutes: '专注分钟',
                  shortBreakMinutes: '短休息分钟',
                  longBreakMinutes: '长休息分钟',
                  longBreakEvery: '长休息间隔（轮）',
                }[key]
              }
              <input
                type="number"
                min={1}
                max={key === 'longBreakEvery' ? 20 : 240}
                value={s[key]}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (v >= 1 && v <= (key === 'longBreakEvery' ? 20 : 240))
                    set({ [key]: v });
                }}
              />
            </label>
          ))}
          <label>
            任务播放按钮
            <select
              value={s.taskTimer}
              onChange={(e) =>
                set({
                  taskTimer: e.target.value as SettingsRecord['taskTimer'],
                })
              }
            >
              <option value="stopwatch">启动秒表</option>
              <option value="focus">启动关联番茄钟</option>
            </select>
          </label>
        </div>
      </section>
      <section className="p-settings-card">
        <h2>提醒</h2>
        <div className="p-setting-grid">
          <label>
            提醒方式
            <select
              value={s.reminderMode}
              onChange={(e) =>
                set({
                  reminderMode: e.target
                    .value as SettingsRecord['reminderMode'],
                })
              }
            >
              <option value="popup">桌面角落提醒卡片</option>
              <option value="system">系统通知</option>
            </select>
          </label>
          <label>
            卡片位置
            <select
              value={s.popupCorner}
              onChange={(e) =>
                set({
                  popupCorner: e.target.value as SettingsRecord['popupCorner'],
                })
              }
            >
              <option value="bottom-right">右下角</option>
              <option value="top-right">右上角</option>
              <option value="bottom-left">左下角</option>
              <option value="top-left">左上角</option>
            </select>
          </label>
          <label>
            重复提醒
            <select
              value={s.reminderRepeat}
              onChange={(e) => set({ reminderRepeat: Number(e.target.value) })}
            >
              <option value={0}>只提醒一次</option>
              <option value={1}>每分钟，直到处理</option>
              <option value={5}>每 5 分钟，直到处理</option>
              <option value={10}>每 10 分钟，直到处理</option>
            </select>
          </label>
          <label>
            音量
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={s.volume}
              onChange={(e) => set({ volume: Number(e.target.value) })}
            />
          </label>
        </div>
        <label className="p-inline-check">
          <input
            type="checkbox"
            checked={s.sound}
            onChange={(e) => set({ sound: e.target.checked })}
          />
          播放提示音
        </label>
        <label className="p-inline-check">
          <input
            type="checkbox"
            checked={s.ramp}
            onChange={(e) => set({ ramp: e.target.checked })}
          />
          反复提醒时逐渐提高音量
        </label>
        <label>
          自定义提示音
          <input
            type="file"
            accept="audio/mpeg,audio/wav,audio/ogg,audio/flac"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              if (file.size > 5 * 1024 * 1024) {
                setMessage('提示音请小于 5 MB');
                return;
              }
              const reader = new FileReader();
              reader.onload = () => set({ soundData: String(reader.result) });
              reader.readAsDataURL(file);
            }}
          />
        </label>
        {s.soundData && (
          <div className="p-field-row">
            <audio controls src={s.soundData} />
            <button onClick={() => set({ soundData: '' })}>恢复内置声音</button>
          </div>
        )}
        <button
          onClick={async () => {
            if (!native) {
              setMessage('系统通知需要在桌面安装版中启用');
              return;
            }
            try {
              const granted =
                (await isPermissionGranted()) ||
                (await requestPermission()) === 'granted';
              setMessage(
                granted
                  ? '系统通知权限已启用'
                  : '请在系统设置中允许空核编辑器发送通知',
              );
            } catch (e) {
              setMessage(String(e));
            }
          }}
        >
          检查系统通知权限
        </button>
      </section>
      <section className="p-settings-card">
        <h2>外观与习惯</h2>
        <div className="p-setting-grid">
          <label>
            主题
            <select
              value={appearance}
              onChange={(e) =>
                setAppearance(e.target.value as typeof appearance)
              }
            >
              <option value="system">跟随系统</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </label>
          <label>
            时间格式
            <select
              value={s.hour12}
              onChange={(e) =>
                set({ hour12: e.target.value as SettingsRecord['hour12'] })
              }
            >
              <option value="system">跟随系统</option>
              <option value="12">12 小时</option>
              <option value="24">24 小时</option>
            </select>
          </label>
          <label>
            一周开始于
            <select
              value={s.weekStart}
              onChange={(e) =>
                set({
                  weekStart: e.target.value as SettingsRecord['weekStart'],
                })
              }
            >
              <option value="system">跟随系统</option>
              <option value="1">星期一</option>
              <option value="0">星期日</option>
            </select>
          </label>
          <label>
            常用提醒时间
            <input
              defaultValue={s.quickTimes.join(', ')}
              onBlur={(e) => {
                const times = [
                  ...new Set(
                    e.target.value
                      .split(/[,，\s]+/)
                      .filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)),
                  ),
                ];
                set({ quickTimes: times });
              }}
              placeholder="09:00, 14:00, 18:00"
            />
          </label>
        </div>
        {(
          [
            'relativeDates',
            'celebrate',
            'streak',
            'closeToTray',
            'startHidden',
          ] as const
        ).map((key) => (
          <label className="p-inline-check" key={key}>
            <input
              type="checkbox"
              checked={s[key]}
              onChange={(e) => set({ [key]: e.target.checked })}
            />
            {
              {
                relativeDates: '显示相对日期',
                celebrate: '完成任务时庆祝（遵循减少动态效果设置）',
                streak: '显示连续完成天数',
                closeToTray: '关闭窗口时继续在托盘运行',
                startHidden: '开机启动时隐藏主窗口',
              }[key]
            }
          </label>
        ))}
        <label className="p-inline-check">
          <input
            type="checkbox"
            disabled={!native}
            checked={autostart}
            onChange={async (e) => {
              const checked = e.target.checked;
              try {
                if (checked) await enable();
                else await disable();
                setAutostart(checked);
              } catch (e) {
                setMessage(String(e));
              }
            }}
          />
          登录系统时自动启动
        </label>
      </section>
      <Account data={data} />
      <section className="p-settings-card">
        <h2>快捷键</h2>
        <p>
          <kbd>Ctrl Alt A</kbd> 全局快速添加（桌面版）
        </p>
        <p>
          <kbd>N</kbd> 添加任务　<kbd>/</kbd> 搜索任务　<kbd>Shift J</kbd>{' '}
          日记　<kbd>?</kbd> 快捷键说明
        </p>
        <p className="p-muted">
          输入文字时不会触发单键快捷键。任务可用 Tab、Enter、空格操作。
        </p>
      </section>
      {message && (
        <p role="status" className="p-notice">
          {message}
        </p>
      )}
    </section>
  );
}
