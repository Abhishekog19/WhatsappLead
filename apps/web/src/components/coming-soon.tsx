/**
 * Stand-in for a tab whose feature lands in a later phase.
 *
 * Present so navigation never dead-ends during the build-out, and so the
 * information architecture can be reviewed on a real device before the
 * screens behind it exist.
 */
export function ComingSoon({
  title,
  description,
  phase,
}: {
  title: string;
  description: string;
  phase: string;
}) {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      <div className="card">
        <p className="text-sm text-neutral-600 dark:text-neutral-400">{description}</p>
        <p className="mt-3 text-xs font-medium text-neutral-500">Arriving in {phase}.</p>
      </div>
    </div>
  );
}
