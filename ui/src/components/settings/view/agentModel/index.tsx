import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePilotDeckConfig } from "../../../../hooks/usePilotDeckConfig";
import { configToYamlString, safeParseYaml } from "../modelPool/utils/configYaml";
import type { PilotDeckConfig } from "../modelPool/types";
import { ConfigSaveError } from "../../shared/view";
import AgentsSection from "./components/AgentsSection";

type AgentModelSectionsProps = {
  title: string;
};

export default function AgentModelSections({ title }: AgentModelSectionsProps) {
  const { t } = useTranslation("settings");
  const { raw, commitRaw, loading, error } = usePilotDeckConfig();
  const [formError, setFormError] = useState<string | null>(null);
  const parsedConfig = useMemo(() => safeParseYaml(raw), [raw]);

  const onFormChange = async (next: PilotDeckConfig) => {
    try {
      setFormError(null);
      await commitRaw(configToYamlString(next));
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : "Failed to save agent model config");
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
        <div className="py-6 text-xs text-muted-foreground">
          {t("pilotDeckConfig.loading")}
        </div>
      </div>
    );
  }

  if (!parsedConfig) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {t("settingsPage.invalidYaml.agentModel")}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
      <ConfigSaveError error={error} />
      {formError && <ConfigSaveError error={formError} />}
      <AgentsSection config={parsedConfig} onChange={onFormChange} />
    </div>
  );
}
