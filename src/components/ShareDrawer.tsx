import { useEffect, useRef, useState } from 'react';
import {
  clearComments,
  copyText,
  createShare,
  editKeyFor,
  ownerTokenFor,
  postComment,
  shareUrl,
  viewIdFor,
  viewUrl,
  type ProposalMeta,
} from '../share/api';
import {
  discardProposal,
  exitSharedView,
  myProposals,
  ownerEnsureEditorKey,
  ownerEnsureViewId,
  ownerPreviewProposal,
  ownerPublish,
  ownerResolve,
  publishAsEditor,
  refreshDoc,
  reviseProposal,
  sendProposal,
  startProposing,
  useShareStore,
} from '../share/shareStore';
import type { ShareRole } from '../share/links';
import { remixShared, useProjectStore } from '../projects/projectStore';
import { relativeTime } from '../projects/library';
import { usePreviewStore } from '../preview';
import { toast, toastError } from '../toast';
import '../styles/projects.css';

const NAME_KEY = 'gaudi-comment-name';

function rememberedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

function rememberName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* not essential */
  }
}

const STATUS_LABEL: Record<ProposalMeta['status'], string> = {
  open: 'open',
  accepted: 'accepted',
  dismissed: 'dismissed',
  changes: 'needs changes',
};

/** Copies on click and says so for a moment. */
function CopyButton({ text, label = 'Copy', disabled }: { text: () => string; label?: string; disabled?: boolean }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <button
      className="btn small"
      disabled={disabled}
      onClick={() => {
        void copyText(text()).then((ok) => {
          if (!ok) {
            toastError('Could not copy. Select the link and copy it by hand.');
            return;
          }
          setCopied(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

function CommentSection({ id, canPost, canClear = false }: { id: string; canPost: boolean; canClear?: boolean }) {
  const comments = useShareStore((s) => s.doc?.comments) ?? [];
  const [name, setName] = useState(rememberedName);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Clearing takes two clicks: the first only asks. */
  const [sure, setSure] = useState(false);
  const sureTimer = useRef<number | undefined>(undefined);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      window.clearTimeout(sureTimer.current);
    };
  }, []);

  const clear = async () => {
    if (busy) return;
    window.clearTimeout(sureTimer.current);
    if (!sure) {
      setSure(true);
      sureTimer.current = window.setTimeout(() => setSure(false), 4000);
      return;
    }
    setSure(false);
    setBusy(true);
    setError(null);
    try {
      await clearComments(id);
      await refreshDoc();
    } catch (e) {
      if (live.current) setError(e instanceof Error ? e.message : 'The comments could not be cleared.');
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const post = async () => {
    if (busy || !name.trim() || !text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await postComment(id, name.trim(), text.trim());
      rememberName(name.trim());
      if (live.current) setText('');
      await refreshDoc();
    } catch (e) {
      if (live.current) setError(e instanceof Error ? e.message : 'The comment could not be posted.');
    } finally {
      if (live.current) setBusy(false);
    }
  };

  return (
    <div className="sd-section">
      {canClear && comments.length > 0 ? (
        <div className="sd-role">
          <span className="sd-title">Comments</span>
          <button
            className="btn small quiet"
            disabled={busy}
            title="Remove every comment from this link"
            onClick={() => void clear()}
          >
            {sure ? `Clear all ${comments.length}?` : 'Clear'}
          </button>
        </div>
      ) : (
        <div className="sd-title">Comments</div>
      )}
      {comments.length === 0 && <div className="sd-empty">No comments yet.</div>}
      {comments.map((c, i) => (
        <div key={`${c.at}-${i}`} className="sd-comment">
          <span className="sd-author">{c.author}</span>
          <span className="sd-text">{c.text}</span>
        </div>
      ))}
      {canPost && (
        <>
          <input
            placeholder="Your name"
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <textarea
            placeholder="Leave a comment…"
            value={text}
            rows={2}
            maxLength={1000}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void post();
            }}
          />
          {error && <div className="sd-err">{error}</div>}
          <button className="btn primary" disabled={busy || !name.trim() || !text.trim()} onClick={() => void post()}>
            Comment
          </button>
        </>
      )}
    </div>
  );
}

/** Visitor side: what became of the proposals on this link. */
function VisitorProposals({ id, canRevise }: { id: string; canRevise: boolean }) {
  const proposals = useShareStore((s) => s.doc?.proposals) ?? [];
  const busy = useShareStore((s) => s.busy);
  if (proposals.length === 0) return null;
  const mine = new Set(myProposals(id));
  return (
    <div className="sd-section">
      <div className="sd-title">Proposals</div>
      {proposals
        .slice()
        .reverse()
        .map((p) => (
          <div key={p.pid} className={`sd-proposal ${p.status === 'open' || p.status === 'changes' ? '' : 'sd-settled'}`}>
            <div className="sd-proposal-head">
              <span className="sd-author">
                {p.author}
                {mine.has(p.pid) ? ' (you)' : ''}
              </span>
              <span className={`sd-status sd-status-${p.status}`}>{STATUS_LABEL[p.status]}</span>
            </div>
            {p.note && <span className="sd-text">{p.note}</span>}
            {p.status === 'changes' && (
              <>
                {p.reviewNote && <span className="sd-review-note">{p.reviewNote}</span>}
                {canRevise && (
                  <button className="btn small" disabled={busy} onClick={() => void reviseProposal(p.pid)}>
                    Revise
                  </button>
                )}
              </>
            )}
          </div>
        ))}
    </div>
  );
}

const ROLE_HINT: Record<ShareRole, string> = {
  view: 'You are looking at a shared plan.',
  review: 'You are looking at a shared plan. Comment on it, or propose a changed version for the owner to accept.',
  edit: 'You can edit this shared plan. What you publish replaces what everyone sees.',
};

/** Visitor side: viewing someone's shared plan. */
function VisitorDrawer({ id }: { id: string }) {
  const role = useShareStore((s) => s.role);
  const proposing = useShareStore((s) => s.proposing);
  const submitted = useShareStore((s) => s.submitted);
  const busy = useShareStore((s) => s.busy);
  const error = useShareStore((s) => s.error);
  const [name, setName] = useState(rememberedName);
  const [note, setNote] = useState('');

  const send = () => {
    if (busy || !name.trim()) return;
    rememberName(name.trim());
    void sendProposal(name.trim(), note.trim()).then(() => {
      if (!useShareStore.getState().proposing) setNote('');
    });
  };

  return (
    <>
      <div className="sd-section">
        <div className="sd-title">Shared plan</div>
        {!proposing && <div className="sd-hint">{ROLE_HINT[role]}</div>}
        {submitted && !proposing && <div className="sd-ok">Proposal sent. The owner can review it now.</div>}
        {error && <div className="sd-err">{error}</div>}

        {!proposing && (
          <>
            {role === 'review' && (
              <button className="btn primary" disabled={busy} onClick={startProposing}>
                Propose changes
              </button>
            )}
            {role === 'edit' && (
              <button className="btn primary" disabled={busy} onClick={startProposing}>
                Edit this plan
              </button>
            )}
            <button
              className={role === 'view' ? 'btn primary' : 'btn'}
              title="Copy this plan into your own projects"
              onClick={() => remixShared()}
            >
              Remix into my projects
            </button>
            <button className="btn quiet" onClick={() => exitSharedView()}>
              Back to my own plan
            </button>
          </>
        )}

        {proposing && role === 'edit' && (
          <>
            <div className="sd-hint sd-draft">Editing. Nothing changes for others until you publish.</div>
            <button className="btn primary" disabled={busy} onClick={() => void publishAsEditor()}>
              Publish changes
            </button>
            <button className="btn" disabled={busy} onClick={discardProposal}>
              Discard changes
            </button>
          </>
        )}

        {proposing && role !== 'edit' && (
          <>
            <div className="sd-hint sd-draft">
              Draft. Change the plan freely; the original stays as it is until the owner accepts.
            </div>
            <input
              placeholder="Your name"
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
            />
            <textarea
              placeholder="What did you change, and why?"
              value={note}
              rows={2}
              maxLength={500}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
            />
            <button className="btn primary" disabled={busy || !name.trim()} onClick={send}>
              Send proposal
            </button>
            <button className="btn" disabled={busy} onClick={discardProposal}>
              Discard draft
            </button>
          </>
        )}
      </div>
      {!proposing && role !== 'view' && <VisitorProposals id={id} canRevise={role === 'review'} />}
      {!proposing && role !== 'view' && <CommentSection id={id} canPost />}
    </>
  );
}

/** One open proposal on the owner's side: look, accept, ask for changes, dismiss. */
function OwnerProposal({ p }: { p: ProposalMeta }) {
  const busy = useShareStore((s) => s.busy);
  const reviewing = useShareStore((s) => s.reviewingPid === p.pid);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');

  const ask = () => {
    if (busy) return;
    void ownerResolve(p.pid, 'changes', note.trim());
  };

  return (
    <div className={`sd-proposal ${reviewing ? 'sd-reviewing' : ''}`}>
      <div className="sd-proposal-head">
        <span className="sd-author">{p.author}</span>
        {p.status === 'changes' && <span className="sd-status sd-status-changes">needs changes</span>}
      </div>
      <span className="sd-text">{p.note || `${p.items} ${p.items === 1 ? 'item' : 'items'}`}</span>
      {p.status === 'changes' && p.reviewNote && <span className="sd-review-note">{p.reviewNote}</span>}
      {!asking ? (
        <div className="sd-row">
          <button className="btn small" disabled={busy || reviewing} onClick={() => void ownerPreviewProposal(p.pid)}>
            View
          </button>
          <button className="btn small accent" disabled={busy} onClick={() => void ownerResolve(p.pid, 'accept')}>
            Accept
          </button>
          {p.status === 'open' && (
            <button className="btn small" disabled={busy} title="Send it back with a note" onClick={() => setAsking(true)}>
              Changes
            </button>
          )}
          <button className="btn small" disabled={busy} onClick={() => void ownerResolve(p.pid, 'dismiss')}>
            Dismiss
          </button>
        </div>
      ) : (
        <>
          <input
            autoFocus
            placeholder="What should change?"
            value={note}
            maxLength={300}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') ask();
              if (e.key === 'Escape') setAsking(false);
            }}
          />
          <div className="sd-row">
            <button className="btn small accent" disabled={busy} onClick={ask}>
              Ask for changes
            </button>
            <button className="btn small" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Owner side, once the project has a link. */
function OwnerLink({ shareId }: { shareId: string }) {
  const doc = useShareStore((s) => s.doc);
  const busy = useShareStore((s) => s.busy);
  const error = useShareStore((s) => s.error);
  const previewing = usePreviewStore((s) => s.active);
  const hasOwnerKey = !!ownerTokenFor(shareId);
  const [canEdit, setCanEdit] = useState(() => !!editKeyFor(shareId));
  const [canView, setCanView] = useState(() => !!viewIdFor(shareId));
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let live = true;
    void refreshDoc().then(() => live && setNow(Date.now()));
    void ownerEnsureEditorKey().then((ok) => live && setCanEdit(ok));
    void ownerEnsureViewId().then((ok) => live && setCanView(ok));
    return () => {
      live = false;
    };
  }, [shareId]);

  const proposals = doc?.proposals ?? [];
  const waiting = proposals.filter((p) => p.status === 'open' || p.status === 'changes');
  const settled = proposals.filter((p) => p.status === 'accepted' || p.status === 'dismissed');
  const openCount = proposals.filter((p) => p.status === 'open').length;
  const published = doc ? Date.parse(doc.updatedAt) : NaN;

  return (
    <>
      <div className="sd-section">
        <div className="sd-title">Share link</div>
        <div className="sd-linkrow">
          <input
            readOnly
            aria-label="Share link"
            value={shareUrl(shareId)}
            onFocus={(e) => e.target.select()}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <CopyButton text={() => shareUrl(shareId)} />
        </div>
        <div className="sd-hint">Anyone with this link can view, comment and propose changes.</div>

        <div className="sd-role">
          <span>
            <span className="sd-role-name">View only</span>
            <span className="sd-role-sub">{canView ? 'just the plan' : 'not available'}</span>
          </span>
          <CopyButton text={() => viewUrl(shareId) ?? ''} disabled={!canView} />
        </div>
        <div className="sd-role">
          <span>
            <span className="sd-role-name">Can edit</span>
            <span className="sd-role-sub">{canEdit ? 'publishes without asking' : 'not available'}</span>
          </span>
          <span className="row" style={{ gap: 4 }}>
            {canEdit && hasOwnerKey && (
              <button
                className="btn small quiet"
                title="Make a new edit link; the old one stops working"
                onClick={() =>
                  void ownerEnsureEditorKey(true).then(
                    (ok) => ok && toast('New edit link ready. The old one no longer works.'),
                  )
                }
              >
                Reset
              </button>
            )}
            <CopyButton text={() => shareUrl(shareId, 'edit')} disabled={!canEdit} />
          </span>
        </div>

        {error && <div className="sd-err">{error}</div>}
        {hasOwnerKey ? (
          <>
            <button
              className="btn primary"
              disabled={busy || previewing}
              title={previewing ? 'Leave the preview first' : undefined}
              onClick={() => void ownerPublish()}
            >
              Publish current plan
            </button>
            {Number.isFinite(published) && (
              <div className="sd-hint">The link shows the plan as published {relativeTime(published, Math.max(now, published))}.</div>
            )}
          </>
        ) : (
          <div className="sd-hint sd-draft">
            This browser no longer holds the key for this link, so it cannot publish to it or accept proposals.
          </div>
        )}
      </div>

      {hasOwnerKey && (
        <div className="sd-section">
          <div className="sd-title">Proposals{openCount > 0 ? ` · ${openCount} open` : ''}</div>
          {proposals.length === 0 && <div className="sd-empty">None yet. Viewers can propose layouts.</div>}
          {waiting.map((p) => (
            <OwnerProposal key={p.pid} p={p} />
          ))}
          {settled.map((p) => (
            <div key={p.pid} className="sd-proposal sd-done">
              <span className="sd-author">{p.author}</span>
              <span className="sd-text">{STATUS_LABEL[p.status]}</span>
            </div>
          ))}
        </div>
      )}

      <CommentSection id={shareId} canPost canClear={hasOwnerKey} />
    </>
  );
}

/** Owner side: the link of the project on the canvas. */
function OwnerDrawer() {
  const shareId = useProjectStore((s) => s.projects.find((p) => p.id === s.currentId)?.shareId ?? null);
  const busy = useShareStore((s) => s.busy);
  const error = useShareStore((s) => s.error);
  const previewing = usePreviewStore((s) => s.active);

  const create = async () => {
    // A preview on the canvas is a candidate, not the plan: nothing to share yet.
    if (usePreviewStore.getState().active || useShareStore.getState().busy) return;
    useShareStore.setState({ busy: true, error: null });
    try {
      await createShare();
      useShareStore.setState({ busy: false });
    } catch (e) {
      useShareStore.setState({
        busy: false,
        error: e instanceof Error ? e.message : 'The link could not be made.',
      });
    }
  };

  if (shareId) return <OwnerLink key={shareId} shareId={shareId} />;

  return (
    <div className="sd-section">
      <div className="sd-title">Share this plan</div>
      <div className="sd-hint">
        Publishes this plan at a link. Anyone with it can view, comment and propose changes; only you
        decide what is accepted.
      </div>
      {error && <div className="sd-err">{error}</div>}
      <button
        className="btn primary"
        disabled={busy || previewing}
        title={previewing ? 'Leave the preview first' : undefined}
        onClick={() => void create()}
      >
        Create share link
      </button>
    </div>
  );
}

export function ShareDrawer() {
  const viewId = useShareStore((s) => s.viewId);
  const status = useShareStore((s) => s.status);
  const error = useShareStore((s) => s.error);

  return (
    <aside className="share-drawer">
      {status === 'loading' && !viewId ? (
        <div className="sd-section">
          <div className="sd-hint">Loading shared plan…</div>
        </div>
      ) : status === 'error' && !viewId ? (
        <div className="sd-section">
          <div className="sd-title">Shared plan</div>
          <div className="sd-err">{error ?? 'This link could not be loaded.'}</div>
          <div className="sd-hint">You are on your own plan.</div>
        </div>
      ) : viewId ? (
        <VisitorDrawer key={viewId} id={viewId} />
      ) : (
        <OwnerDrawer />
      )}
    </aside>
  );
}
