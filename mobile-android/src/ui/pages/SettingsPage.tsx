// 设置页：本机偏好 + 数据健康 + 设备自检入口 + 同步。
//
// 同步区把"凭据能改、结果看得见、坏了能退"三件事都放进来：
// 仓库/分支/PAT 可改可清、上次同步时间与结论、连接验证结果、以及逐文件的同步明细
// （明细很重要：行合并是自动的，用户得有地方核对它到底做了什么）。
//
// 刻意不放"工作区"那块信息（本机路径、加载耗时、日志条数、压实建议）：那是给自己看的
// 诊断口径，不是给用户看的设置项——本机绝对路径、事件条数、压实这些词对一个只想知道
// "怎么同步/怎么换字号"的人全是噪音。启动耗时仍在 logcat 里（`[miki-boot]`）。
import { useEffect, useState } from 'react'
import { useApp } from '../store'
import { useWorkspace } from '../use-workspace'
import { PREF_KEYS, prefRemove } from '@mobile/prefs'
import { Sheet } from '../components/Sheet'
import { SyncConfigForm } from '../forms/SyncConfigForm'
import type { FontScale, ThemePref } from '@mobile/theme'

export function SettingsPage(): JSX.Element {
  const ws = useWorkspace()
  const back = useApp((s) => s.back)
  const go = useApp((s) => s.go)
  const prefs = useApp((s) => s.prefs)
  const setPref = useApp((s) => s.setPref)
  const [reset, setReset] = useState<string | null>(null)
  const [configSync, setConfigSync] = useState(false)
  const [showDetail, setShowDetail] = useState(false)
  const sync = useApp((s) => s.sync)
  const loadSyncInfo = useApp((s) => s.loadSyncInfo)
  const syncNow = useApp((s) => s.syncNow)
  const clearSyncCreds = useApp((s) => s.clearSyncCreds)

  useEffect(() => {
    void loadSyncInfo()
  }, [loadSyncInfo])

  const dmg = ws.damageReport()

  return (
    <>
      <div className="page-head">
        <button className="icon-btn" onClick={back} aria-label="返回">
          ‹
        </button>
        <h1>设置</h1>
      </div>

      <div className="page-body">
        <section className="card">
          <h2>显示</h2>
          <div className="seg">
            {(['system', 'light', 'dark'] as ThemePref[]).map((t) => (
              <button
                key={t}
                className={`seg-btn${prefs.theme === t ? ' on' : ''}`}
                onClick={() => void setPref('theme', t)}
              >
                {t === 'system' ? '跟随系统' : t === 'light' ? '浅色' : '深色'}
              </button>
            ))}
          </div>
          <div className="seg">
            {(['small', 'medium', 'large'] as FontScale[]).map((f) => (
              <button
                key={f}
                className={`seg-btn${prefs.fontScale === f ? ' on' : ''}`}
                onClick={() => void setPref('fontScale', f)}
              >
                {f === 'small' ? '小' : f === 'medium' ? '中' : '大'}
              </button>
            ))}
          </div>
          <label className="switch-row">
            <span>
              学习时屏幕常亮
              <em className="muted">刷卡时不想被息屏打断；电量紧张可以关掉</em>
            </span>
            <input
              type="checkbox"
              checked={prefs.keepAwake}
              onChange={(e) => void setPref('keepAwake', e.target.checked)}
            />
          </label>
        </section>

        <section className="card">
          <h2>同步</h2>
          {sync.status?.configured ? (
            <>
              <p className="muted">
                仓库 <code>{sync.status.repo}</code>（分支 {sync.status.branch}），凭据 {sync.status.tokenMask}
              </p>
              <p className="muted">
                上次同步：
                {sync.lastSyncAt ? new Date(sync.lastSyncAt).toLocaleString() : '还没同步过'}
                {sync.report ? ` · ${sync.report.ok ? '成功' : '未完成'}` : ''}
              </p>
              {sync.verify ? (
                <p className={sync.verify.ok ? 'muted' : 'note'}>
                  连接验证：{sync.verify.ok ? '通过' : '失败'}（{new Date(sync.verify.at).toLocaleString()}）
                  {sync.verify.ok ? '' : ` —— ${sync.verify.message}`}
                </p>
              ) : null}
              {sync.report ? (
                <>
                  <p className="muted">{sync.report.message}</p>
                  <button className="btn" onClick={() => setShowDetail(true)}>
                    看本次同步明细
                  </button>
                </>
              ) : null}
              {sync.lastError ? <p className="note">{sync.lastError}</p> : null}
              <div className="row-btns">
                <button className="btn primary" disabled={sync.busy} onClick={() => void syncNow('full')}>
                  {sync.busy ? '同步中…' : '立即同步'}
                </button>
                <button className="btn" onClick={() => setConfigSync(true)}>
                  改仓库 / 换 PAT
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="muted">
                还没配置同步：工作区目前只在这台手机上。桌面端与手机之间通过一个 GitHub 私有仓库
                （你自己建的那个）传数据，需要一个只对这一个仓库有 Contents 读写权限的细粒度 PAT。
              </p>
              <p className="note">在同步接上之前，别在这台手机上做"删了就找不回来"的操作：本机的学习记录还没推上去。</p>
              <button className="btn primary" onClick={() => setConfigSync(true)}>
                配置同步
              </button>
            </>
          )}
          <p className="muted">拉取是自动的（回到前台静默拉一次，只读、不产生提交）；推送只在你点"立即同步"时发生。</p>
          {sync.status?.configured ? (
            <button
              className="btn danger"
              onClick={() => {
                void clearSyncCreds()
              }}
            >
              清空凭据
            </button>
          ) : null}
          <button
            className="btn"
            onClick={() => {
              void prefRemove(PREF_KEYS.lastDeckId)
              setReset('已清空本机偏好（工作区数据不受影响）')
            }}
          >
            清空本机偏好
          </button>
          {reset ? <p className="muted">{reset}</p> : null}
        </section>
        <section className="card">
          <h2>数据健康</h2>
          {dmg.damagedLines === 0 && dmg.truncatedFiles.length === 0 && dmg.corruptDocs.length === 0 ? (
            <p className="ok-line">加载正常：没有坏行，没有截断文件，JSON 文档也都读得出来。</p>
          ) : (
            <>
              {dmg.corruptDocs.length > 0 && (
                <>
                  <p className="bad-line">JSON 文档有问题：{dmg.corruptDocs.join('、')}</p>
                  <p className="muted">
                    这几份文件是整份读写的（牌组表、配置），坏掉时整份内容读不出来 ——
                    牌组列表看起来被清空，而卡片文件其实还在（只是暂时成了孤儿）。
                    多半是写入被打断，或同步/外部编辑造成的；先在桌面端把这份文件的 JSON 修好，
                    或让远端那份重新拉下来覆盖本机，再回来同步。
                  </p>
                </>
              )}
              {dmg.damagedLines > 0 || dmg.truncatedFiles.length > 0 ? (
                <>
                  <p className="bad-line">
                    坏行 {dmg.damagedLines} 条
                    {dmg.truncatedFiles.length > 0 ? `，截断文件 ${dmg.truncatedFiles.length} 个` : ''}
                  </p>
                  <p className="muted">
                    坏行会被跳过而不是让整个工作区打不开（这行数据丢了，但它后面的都能读）。
                    出现大量坏行通常意味着同步过程中断了，先在桌面端确认数据完整。
                  </p>
                  <ul className="detail">
                    {dmg.files.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                </>
              ) : null}
            </>
          )}
          <button className="btn" onClick={() => go({ kind: 'selfcheck' })}>
            打开设备自检（读写 / 性能 / 往返一致性）
          </button>
        </section>
      </div>

      <Sheet open={configSync} title="同步配置" onClose={() => setConfigSync(false)}>
        {configSync ? <SyncConfigForm onDone={() => setConfigSync(false)} /> : null}
      </Sheet>

      <Sheet open={showDetail} title="本次同步明细" onClose={() => setShowDetail(false)}>
        {sync.report ? (
          <div className="sync-detail">
            <p className="muted">
              {new Date(sync.report.at).toLocaleString()} · 推送 {sync.report.pushed} 个文件、拉取 {sync.report.pulled}{' '}
              个{sync.report.commit ? ` · 提交 ${sync.report.commit.slice(0, 7)}` : ''}
            </p>
            {sync.report.snapshot ? (
              <p className="muted">推送前的快照：{sync.report.snapshot}（保留最近 5 次）</p>
            ) : null}
            <ul className="sync-files">
              {sync.report.files.map((f) => (
                <li key={f.path}>
                  <code>{f.path}</code>
                  <span className={`tag tag-${f.action}`}>{ACTION_LABEL[f.action] ?? f.action}</span>
                  <span className="muted">{f.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Sheet>
    </>
  )
}

const ACTION_LABEL: Record<string, string> = {
  skip: '不变',
  'keep-local': '推送',
  'take-remote': '拉取',
  union: '合并',
  blocked: '拦下'
}
