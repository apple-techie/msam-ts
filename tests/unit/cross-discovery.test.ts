import { describe, it, expect } from "vitest";
import {
  getVisibleAgents,
  getDiscoveryMode,
  type CrossDiscoveryConfig,
} from "../../src/agents/cross-discovery.js";

const baseConfig: CrossDiscoveryConfig = {
  enabled: true,
  groups: [
    {
      name: "enduru-fleet",
      agents: ["enduru", "enduru-kainotomic", "enduru-botchat", "enduru-group", "dexter", "main"],
    },
    {
      name: "turkules-fleet",
      agents: ["turkules", "mv-ops", "mv-data", "mv-marketing", "mv-product"],
    },
  ],
  bridges: [
    { from: "enduru-fleet", to: "turkules-fleet", mode: "entities-only" },
  ],
};

const fullBridgeConfig: CrossDiscoveryConfig = {
  ...baseConfig,
  bridges: [
    { from: "enduru-fleet", to: "turkules-fleet", mode: "full" },
  ],
};

const offBridgeConfig: CrossDiscoveryConfig = {
  ...baseConfig,
  bridges: [
    { from: "enduru-fleet", to: "turkules-fleet", mode: "off" },
  ],
};

const noBridgeConfig: CrossDiscoveryConfig = {
  ...baseConfig,
  bridges: [],
};

const disabledConfig: CrossDiscoveryConfig = {
  enabled: false,
  groups: baseConfig.groups,
  bridges: baseConfig.bridges,
};

describe("cross-discovery", () => {
  describe("getVisibleAgents", () => {
    it("returns all agents in same group + bridged group agents", () => {
      const visible = getVisibleAgents("enduru", baseConfig);
      expect(visible).toContain("enduru");
      expect(visible).toContain("enduru-kainotomic");
      expect(visible).toContain("dexter");
      expect(visible).toContain("turkules");
      expect(visible).toContain("mv-ops");
      expect(visible.length).toBe(11);
    });

    it("returns only own group when bridge is off", () => {
      const visible = getVisibleAgents("enduru", offBridgeConfig);
      expect(visible).toContain("enduru");
      expect(visible).toContain("dexter");
      expect(visible).not.toContain("turkules");
      expect(visible.length).toBe(6);
    });

    it("returns only own group when no bridge exists", () => {
      const visible = getVisibleAgents("enduru", noBridgeConfig);
      expect(visible).toContain("enduru");
      expect(visible).not.toContain("turkules");
      expect(visible.length).toBe(6);
    });

    it("returns only itself when agent not in any group", () => {
      const visible = getVisibleAgents("aurora", baseConfig);
      expect(visible).toEqual(["aurora"]);
    });

    it("returns only itself when discovery is disabled", () => {
      const visible = getVisibleAgents("enduru", disabledConfig);
      expect(visible).toEqual(["enduru"]);
    });

    it("works from the other group's perspective", () => {
      const visible = getVisibleAgents("turkules", baseConfig);
      expect(visible).toContain("turkules");
      expect(visible).toContain("mv-ops");
      expect(visible).toContain("enduru");
      expect(visible.length).toBe(11);
    });
  });

  describe("getDiscoveryMode", () => {
    it("returns full for agents in the same group", () => {
      expect(getDiscoveryMode("enduru", "dexter", baseConfig)).toBe("full");
    });

    it("returns full for same agent", () => {
      expect(getDiscoveryMode("enduru", "enduru", baseConfig)).toBe("full");
    });

    it("returns bridge mode for agents in bridged groups", () => {
      expect(getDiscoveryMode("enduru", "turkules", baseConfig)).toBe("entities-only");
    });

    it("returns full for full-mode bridge", () => {
      expect(getDiscoveryMode("enduru", "turkules", fullBridgeConfig)).toBe("full");
    });

    it("returns off for off-mode bridge", () => {
      expect(getDiscoveryMode("enduru", "turkules", offBridgeConfig)).toBe("off");
    });

    it("returns off when no bridge exists", () => {
      expect(getDiscoveryMode("enduru", "turkules", noBridgeConfig)).toBe("off");
    });

    it("returns off when agent not in any group", () => {
      expect(getDiscoveryMode("aurora", "enduru", baseConfig)).toBe("off");
    });

    it("returns off when neither agent is in a group", () => {
      expect(getDiscoveryMode("aurora", "sam", baseConfig)).toBe("off");
    });

    it("returns off when discovery is disabled", () => {
      expect(getDiscoveryMode("enduru", "dexter", disabledConfig)).toBe("off");
    });

    it("is symmetric for bridged groups", () => {
      const ab = getDiscoveryMode("enduru", "turkules", baseConfig);
      const ba = getDiscoveryMode("turkules", "enduru", baseConfig);
      expect(ab).toBe(ba);
    });
  });

  describe("config schema integration", () => {
    it("parses cross_discovery from TOML config", async () => {
      const { loadConfigFromString, resetConfig } = await import("../../src/config/index.js");
      resetConfig();

      const cfg = loadConfigFromString(`
[agents]
default_agent_id = "enduru"

[agents.cross_discovery]
enabled = true

[[agents.cross_discovery.groups]]
name = "fleet-a"
agents = ["agent1", "agent2"]

[[agents.cross_discovery.groups]]
name = "fleet-b"
agents = ["agent3", "agent4"]

[[agents.cross_discovery.bridges]]
from = "fleet-a"
to = "fleet-b"
mode = "entities-only"
`);

      expect(cfg.agents.cross_discovery.enabled).toBe(true);
      expect(cfg.agents.cross_discovery.groups).toHaveLength(2);
      expect(cfg.agents.cross_discovery.groups[0].name).toBe("fleet-a");
      expect(cfg.agents.cross_discovery.groups[0].agents).toEqual(["agent1", "agent2"]);
      expect(cfg.agents.cross_discovery.bridges).toHaveLength(1);
      expect(cfg.agents.cross_discovery.bridges[0].mode).toBe("entities-only");

      resetConfig();
    });

    it("defaults to disabled with empty groups and bridges", async () => {
      const { loadConfigFromString, resetConfig } = await import("../../src/config/index.js");
      resetConfig();

      const cfg = loadConfigFromString(`
[agents]
default_agent_id = "enduru"
`);

      expect(cfg.agents.cross_discovery.enabled).toBe(false);
      expect(cfg.agents.cross_discovery.groups).toEqual([]);
      expect(cfg.agents.cross_discovery.bridges).toEqual([]);

      resetConfig();
    });
  });

  describe("bridge mode filtering", () => {
    it("entities-only mode does not imply full access", () => {
      const mode = getDiscoveryMode("enduru", "turkules", baseConfig);
      expect(mode).toBe("entities-only");
      expect(mode).not.toBe("full");
    });

    it("three groups with selective bridges", () => {
      const threeGroupConfig: CrossDiscoveryConfig = {
        enabled: true,
        groups: [
          { name: "group-a", agents: ["a1", "a2"] },
          { name: "group-b", agents: ["b1", "b2"] },
          { name: "group-c", agents: ["c1", "c2"] },
        ],
        bridges: [
          { from: "group-a", to: "group-b", mode: "full" },
        ],
      };

      expect(getDiscoveryMode("a1", "b1", threeGroupConfig)).toBe("full");
      expect(getDiscoveryMode("a1", "c1", threeGroupConfig)).toBe("off");
      expect(getDiscoveryMode("b1", "c1", threeGroupConfig)).toBe("off");
      expect(getDiscoveryMode("a1", "a2", threeGroupConfig)).toBe("full");

      const visibleA = getVisibleAgents("a1", threeGroupConfig);
      expect(visibleA).toContain("b1");
      expect(visibleA).not.toContain("c1");

      const visibleC = getVisibleAgents("c1", threeGroupConfig);
      expect(visibleC).toEqual(["c1", "c2"]);
    });
  });
});
