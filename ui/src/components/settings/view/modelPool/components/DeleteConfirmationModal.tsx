import type { TFunction } from 'i18next';
import { ConfirmDialog } from '../../../../ui/ConfirmDialog';
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PendingIcon } from "./icons";

export type ModelUsageReference = {
  path: string;
  value: string;
  kind: string;
};

type UsageItem = {
  modelName?: string;
  reference: ModelUsageReference;
};

type DeleteConfirmationModalProps = {
  kind: "model" | "provider";
  name: string;
  usages: UsageItem[];
  loading: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
  replacementOptions?: string[];
  onReplaceDefault?: (modelRef: string) => Promise<void>;
};

function routeName(value: string, t: TFunction): string {
  if (value === "default") return t('common:modelUsage.defaultRoute');
  return value.replace(/[_-]/g, " ");
}

function usageLabel(path: string, t: TFunction): string {
  if (path === "agent.model") return t('common:modelUsage.primaryModel');
  if (path === "agent.subagents.default") return t('common:modelUsage.subagentModel');
  if (path === "memory.model") return t('common:modelUsage.memoryModel');

  const scenario = /^router\.scenarios\.([^.]+)$/.exec(path);
  if (scenario) return t('common:modelUsage.preferred', { route: routeName(scenario[1], t) });

  const fallback = /^router\.fallback\.([^.]+)\.\d+$/.exec(path);
  if (fallback) return t('common:modelUsage.fallback', { route: routeName(fallback[1], t) });

  if (path === "router.tokenSaver.judge") return t('common:modelUsage.judgeModel');
  const tier = /^router\.tokenSaver\.tiers\.([^.]+)\.model$/.exec(path);
  if (tier) return t('common:modelUsage.tier', { route: routeName(tier[1], t) });
  if (path === "router.stats.baselineModel") return t('common:modelUsage.baselineModel');
  if (path.startsWith("router.stats.modelPricing.")) return t('common:modelUsage.modelPricing');
  return path;
}

export default function DeleteConfirmationModal({
  kind,
  name,
  usages,
  loading,
  error,
  onCancel,
  onConfirm,
  replacementOptions = [],
  onReplaceDefault,
}: DeleteConfirmationModalProps) {
  const { t } = useTranslation("settings");
  const [replacement, setReplacement] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [replacementError, setReplacementError] = useState("");
  const hasDefaultReference = usages.some(item => item.reference.path === "agent.model");
  const hasOtherReferences = usages.some(item => item.reference.path !== "agent.model");
  const canReplace = Boolean(onReplaceDefault && hasDefaultReference && !hasOtherReferences);
  const clearsDefault = canReplace && replacementOptions.length === 0;
  const replaceDefault = async () => {
    if (!onReplaceDefault || !canReplace || loading || error || replacing || (!clearsDefault && !replacementOptions.includes(replacement))) return;
    setReplacing(true);
    setReplacementError("");
    try { await onReplaceDefault(clearsDefault ? "" : replacement); }
    catch (caught) { setReplacementError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setReplacing(false); }
  };
  const inUse = usages.length > 0;
  const blocked = loading || replacing || Boolean(error) || (inUse && !(canReplace && (clearsDefault || replacementOptions.includes(replacement))));
  const title = inUse && !clearsDefault
    ? kind === "model"
      ? t("pilotDeckConfig.panels.models.deleteDialog.modelBlockedTitle", { name })
      : t("pilotDeckConfig.panels.models.deleteDialog.providerTitle", { name })
    : kind === "model"
      ? t("pilotDeckConfig.panels.models.deleteDialog.modelTitle", { name })
      : t("pilotDeckConfig.panels.models.deleteDialog.providerTitle", { name });

  return (
    <ConfirmDialog title={title} destructive busy={replacing} disabled={blocked}
      confirmLabel={t(`pilotDeckConfig.panels.models.deleteDialog.${canReplace && !clearsDefault ? "replaceDefault" : "delete"}`)}
      onCancel={onCancel} onConfirm={() => { if (canReplace) void replaceDefault(); else onConfirm(); }}>
          {loading ? (
            <p className="text-sm">{t("pilotDeckConfig.panels.models.deleteDialog.checking")}</p>
          ) : error ? (
            <div className="flex items-start gap-2">
              <PendingIcon size={22} />
              <p>{error}</p>
            </div>
          ) : inUse && !clearsDefault ? (
            <div className="space-y-3">
              <div className="flex items-start gap-2">
                <PendingIcon size={22} />
                <p>
                  {t(`pilotDeckConfig.panels.models.deleteDialog.${kind}InUse`)}
                </p>
              </div>
              <ul
                className="mt-3 space-y-2"
                aria-label={t("pilotDeckConfig.panels.models.deleteDialog.usageAria")}
              >
                {usages.map(({ modelName, reference }, index) => (
                  <li key={`${reference.path}:${reference.value}:${index}`}>
                    {modelName ? <span className="mr-2 font-mono text-xs">{modelName}</span> : null}
                    <strong>{usageLabel(reference.path, t)}</strong>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-sm">
              {t(`pilotDeckConfig.panels.models.deleteDialog.${kind}Confirm`, { name })}
            </p>
          )}
          {!loading && !error && canReplace && !clearsDefault && (
            <div className="mt-4">
              <label className="flex flex-col gap-2">
                <span>{t("pilotDeckConfig.panels.models.deleteDialog.replacementLabel")}</span>
                <select className="h-9 w-full rounded-md border border-border bg-background px-2 text-foreground" value={replacement} disabled={replacing} onChange={event => setReplacement(event.target.value)}>
                  <option value="">{t("pilotDeckConfig.panels.models.deleteDialog.chooseReplacement")}</option>
                  {replacementOptions.map(ref => <option key={ref} value={ref}>{ref}</option>)}
                </select>
              </label>
              {replacementOptions.length === 0 && <p>{t("pilotDeckConfig.panels.models.deleteDialog.noReplacement")}</p>}
            </div>
          )}
          {replacementError && <p role="alert">{replacementError}</p>}
    </ConfirmDialog>
  );
}
