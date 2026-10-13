"use client";

export default function ScriptIdentity({
  name,
  old,
  size = "md",
}: {
  name: string;
  old?: boolean;
  size?: "sm" | "md";
}) {
  return (
    <span className={`studio-script-id studio-script-id--${size}`} data-testid="active-script-name" title={name}>
      <strong>{name || "—"}</strong>
      {old ? (
        <em data-testid="old-script-badge" title="A newer script file exists">
          old script
        </em>
      ) : null}
    </span>
  );
}
