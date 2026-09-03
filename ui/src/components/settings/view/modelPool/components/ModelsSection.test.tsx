import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PilotDeckConfig } from "../types";
import ModelsSection from "./ModelsSection";
import ProviderCard from "./ProviderCard";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

describe("model provider drafts", () => {
  it("keeps a new custom provider local until it is explicitly saved", () => {
    const onChange = vi.fn();
    const config = { model: { providers: {} } } as PilotDeckConfig;

    render(<ModelsSection config={config} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", {
      name: "pilotDeckConfig.panels.models.addProvider",
    }));
    fireEvent.click(screen.getByRole("button", {
      name: /pilotDeckConfig\.panels\.models\.customProvider/,
    }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("provider1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", {
      name: "settingsPage.actions.cancel",
    }));

    expect(screen.queryByDisplayValue("provider1")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("validates a new provider before calling the save handler", () => {
    const onSave = vi.fn(async () => ({ ok: true }));

    render(
      <ProviderCard
        providerId="provider1"
        provider={{ protocol: "openai", url: "", apiKey: "", models: {} }}
        initialEditing
        onSave={onSave}
        onRemove={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", {
      name: "settingsPage.actions.save",
    }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText(
      "pilotDeckConfig.panels.models.providerUrlRequired",
    )).toBeTruthy();
  });

  it("prevents duplicate saves while the first provider save is pending", async () => {
    let finish!: (result: { ok: boolean }) => void;
    const onSave = vi.fn(() => new Promise<{ ok: boolean }>((resolve) => {
      finish = resolve;
    }));

    render(
      <ProviderCard
        providerId="provider1"
        provider={{
          protocol: "openai",
          url: "https://api.example.test/v1",
          apiKey: "sk-test",
          models: { "model-a": {} },
        }}
        initialEditing
        onSave={onSave}
        onRemove={vi.fn()}
      />,
    );

    const saveButton = screen.getByRole("button", {
      name: "settingsPage.actions.save",
    });
    fireEvent.click(saveButton);
    fireEvent.click(saveButton);

    expect(onSave).toHaveBeenCalledTimes(1);
    finish({ ok: true });
    await waitFor(() => expect(screen.queryByRole("button", {
      name: "settingsPage.actions.save",
    })).toBeNull());
  });
});
