export interface Toast {
  id: number;
  kind: "ok" | "error" | "info";
  text: string;
  detail?: string;
}

export function Toasts({ items, onDismiss }: { items: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((x) => (
        <div key={x.id} className={`toast ${x.kind}`} onClick={() => onDismiss(x.id)}>
          <div>{x.text}</div>
          {x.detail && <div className="mono">{x.detail}</div>}
        </div>
      ))}
    </div>
  );
}
