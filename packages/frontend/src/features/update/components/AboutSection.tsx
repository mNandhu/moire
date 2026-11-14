import { Section } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import { Tooltip } from "@/components/ui/Tooltip";
import { useToast } from "@/components/ui/Toasts";
import { errorText } from "@/lib/api";
import { UpdateDetails } from "@/features/update/components/UpdateNotice";
import { checkedAgo, useCheckNow, useSetUpdateCheck, useVersionStatus } from "@/features/update/lib/version";

/** Settings > About: the version, a waiting update, and the daily check's
 * switch (not in a source checkout, which never checks). */
export function AboutSection() {
  const { data: status } = useVersionStatus();
  const setCheck = useSetUpdateCheck();
  const checkNow = useCheckNow();
  const { push } = useToast();

  if (!status) return <Skeleton className="mx-auto h-24 max-w-2xl rounded-xl" />;

  const toggle = (on: boolean) =>
    setCheck.mutate(on, { onError: (e) => push(errorText(e), "error") });

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <Section title="Moiré" description={`Version ${status.current}`}>
        {status.update_available && (
          <div className="rounded-lg border border-brand-400/45 bg-brand-600/[0.07] px-3.5 py-3">
            <UpdateDetails status={status} showCurrent={false} />
          </div>
        )}
      </Section>
      {status.can_check && (
        <Section
          title={
            <Tooltip content="Asks PyPI once a day. Nothing about this computer is sent.">
              <span className="cursor-help underline decoration-line-strong decoration-dotted underline-offset-[3px]">
                Check for updates
              </span>
            </Tooltip>
          }
          description={status.enabled && status.checked_at ? `Last checked ${checkedAgo(status.checked_at)}.` : undefined}
          actions={
            <>
              {status.enabled && (
                <Button size="sm" variant="ghost" pending={checkNow.isPending} onClick={() => checkNow.mutate(undefined, { onError: (e) => push(errorText(e), "error") })}>
                  Check now
                </Button>
              )}
              <Switch on={status.enabled} onChange={toggle} aria-label="Check for updates" />
            </>
          }
        />
      )}
    </div>
  );
}
