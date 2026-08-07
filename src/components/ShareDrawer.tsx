import { useEffect, useState } from 'react';
import { myShareId, ownerTokenFor, shareUrl, createShare } from '../share/api';
import {
  discardProposal,
  exitSharedView,
  ownerClosePreview,
  ownerPreviewProposal,
  ownerPublish,
  ownerResolve,
  refreshDoc,
  sendProposal,
  startProposing,
  useShareStore,
} from '../share/shareStore';

function rememberedName(): string {
  return localStorage.getItem('gaudi-comment-name') ?? '';
}

function CommentSection() {
  const doc = useShareStore((s) => s.doc);
  const viewId = useShareStore((s) => s.viewId);
  const [name, setName] = useState(rememberedName);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const id = viewId ?? myShareId();

  const post = async () => {
    if (!id || !name.trim() || !text.trim()) return;
    setBusy(true);
    try {
      const { postComment } = await import('../share/api');
      await postComment(id, name.trim(), text.trim());
      localStorage.setItem('gaudi-comment-name', name.trim());
      setText('');
      await refreshDoc();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sd-section">
      <div className="sd-title">Comments</div>
      {(doc?.comments ?? []).length === 0 && <div className="sd-empty">No comments yet.</div>}
      {(doc?.comments ?? []).map((c, i) => (
        <div key={i} className="sd-comment">
          <span className="sd-author">{c.author}</span>
          <span className="sd-text">{c.text}</span>
        </div>
      ))}
      <input
        placeholder="Your name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
      />
      <textarea
        placeholder="Leave a comment…"
        value={text}
        rows={2}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
      />
      <button className="sd-primary" disabled={busy || !name.trim() || !text.trim()} onClick={() => void post()}>
        Comment
      </button>
    </div>
  );
}

/** Visitor side: viewing someone's shared plan. */
function VisitorDrawer() {
  const { proposing, submitted, busy, error } = useShareStore();
  const [name, setName] = useState(rememberedName);
  const [note, setNote] = useState('');

  return (
    <>
      <div className="sd-section">
        <div className="sd-title">Shared plan</div>
        <div className="sd-hint">
          You're viewing a read-only plan. Comment below, or propose a changed
          version — the owner decides whether to accept it.
        </div>
        {submitted && <div className="sd-ok">Proposal sent — the owner can now review it.</div>}
        {error && <div className="sd-err">{error}</div>}
        {!proposing ? (
          <>
            <button className="sd-primary" onClick={startProposing}>
              Propose changes
            </button>
            <button className="sd-ghost" onClick={() => exitSharedView()}>
              Back to my own plan
            </button>
          </>
        ) : (
          <>
            <div className="sd-hint sd-draft">
              Draft mode — edit the plan freely; the original is untouched until
              the owner accepts.
            </div>
            <input
              placeholder="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
            />
            <textarea
              placeholder="What did you change, and why?"
              value={note}
              rows={2}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
            />
            <button
              className="sd-primary"
              disabled={busy || !name.trim()}
              onClick={() => {
                localStorage.setItem('gaudi-comment-name', name.trim());
                void sendProposal(name.trim(), note.trim());
              }}
            >
              Submit proposal
            </button>
            <button className="sd-ghost" onClick={discardProposal}>
              Discard draft
            </button>
          </>
        )}
      </div>
      {!proposing && <CommentSection />}
    </>
  );
}

/** Owner side: manage the share of the local plan. */
function OwnerDrawer() {
  const { doc, busy, error, previewPid } = useShareStore();
  const [shareId, setShareId] = useState<string | null>(myShareId);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (shareId) void refreshDoc();
  }, [shareId]);

  const create = async () => {
    useShareStore.setState({ busy: true, error: null });
    try {
      const id = await createShare();
      setShareId(id);
      useShareStore.setState({ busy: false });
      void refreshDoc();
    } catch (e) {
      useShareStore.setState({
        busy: false,
        error: e instanceof Error ? e.message : 'Failed to share.',
      });
    }
  };

  if (!shareId) {
    return (
      <div className="sd-section">
        <div className="sd-title">Share this plan</div>
        <div className="sd-hint">
          Publishes the current plan at a link anyone can view and comment on.
          Viewers can propose changed versions; only you can accept them.
        </div>
        {error && <div className="sd-err">{error}</div>}
        <button className="sd-primary" disabled={busy} onClick={() => void create()}>
          Create share link
        </button>
      </div>
    );
  }

  const url = shareUrl(shareId);
  const open = (doc?.proposals ?? []).filter((p) => p.status === 'open');
  const resolved = (doc?.proposals ?? []).filter((p) => p.status !== 'open');

  return (
    <>
      {previewPid && (
        <div className="sd-section sd-preview">
          <div className="sd-title">Previewing proposal</div>
          <div className="sd-hint">The canvas shows the proposed layout.</div>
          <button
            className="sd-primary"
            disabled={busy}
            onClick={() => void ownerResolve(previewPid, 'accept')}
          >
            Accept — make this the plan
          </button>
          <button className="sd-ghost" onClick={ownerClosePreview}>
            Back to my plan
          </button>
        </div>
      )}

      <div className="sd-section">
        <div className="sd-title">Share link</div>
        <div className="sd-linkrow">
          <input readOnly value={url} onFocus={(e) => e.target.select()} />
          <button
            className="sd-ghost"
            onClick={() => {
              void navigator.clipboard.writeText(url);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <div className="sd-hint">
          View + comment + propose for anyone with the link. Accepting and
          publishing stay with this browser{ownerTokenFor(shareId) ? '' : ' (owner key missing here!)'}.
        </div>
        {error && <div className="sd-err">{error}</div>}
        <button className="sd-primary" disabled={busy} onClick={() => void ownerPublish()}>
          Publish current plan
        </button>
      </div>

      <div className="sd-section">
        <div className="sd-title">
          Proposals{open.length > 0 ? ` · ${open.length} open` : ''}
        </div>
        {(doc?.proposals ?? []).length === 0 && (
          <div className="sd-empty">None yet — viewers can propose layouts.</div>
        )}
        {open.map((p) => (
          <div key={p.pid} className="sd-proposal">
            <div>
              <span className="sd-author">{p.author}</span>
              <span className="sd-text">{p.note || `${p.items} items`}</span>
            </div>
            <div className="sd-row">
              <button className="sd-ghost" disabled={busy} onClick={() => void ownerPreviewProposal(p.pid)}>
                View
              </button>
              <button className="sd-ghost" disabled={busy} onClick={() => void ownerResolve(p.pid, 'accept')}>
                Accept
              </button>
              <button className="sd-ghost" disabled={busy} onClick={() => void ownerResolve(p.pid, 'dismiss')}>
                Dismiss
              </button>
            </div>
          </div>
        ))}
        {resolved.map((p) => (
          <div key={p.pid} className="sd-proposal sd-done">
            <span className="sd-author">{p.author}</span>
            <span className="sd-text">{p.status}</span>
          </div>
        ))}
      </div>

      <CommentSection />
    </>
  );
}

export function ShareDrawer() {
  const viewId = useShareStore((s) => s.viewId);
  const status = useShareStore((s) => s.status);

  return (
    <aside className="share-drawer">
      {status === 'loading' ? (
        <div className="sd-section"><div className="sd-hint">Loading shared plan…</div></div>
      ) : viewId ? (
        <VisitorDrawer />
      ) : (
        <OwnerDrawer />
      )}
    </aside>
  );
}
