"use client";
import * as React from "react";
import { endpoints } from "@crm/contracts";
import { browserApi } from "@/lib/client-api";
import { NO_LOOKUPS, type Lookups } from "./automation-model";

/** Names for the pickers and the plain-language sentences. A failure only means ids show as typed text. */
export function useLookups(workspaceId: string): Lookups {
  const [lk, setLk] = React.useState<Lookups>(NO_LOOKUPS);
  React.useEffect(() => {
    let alive = true;
    const params = { workspaceId };
    void Promise.all([browserApi.call(endpoints.listLifecycleStages, { params }), browserApi.call(endpoints.listPipelines, { params }), browserApi.call(endpoints.listAiAgents, { params }), browserApi.call(endpoints.listTags, { params })]).then(([st, pl, ag, tg]) => {
      if (!alive) return;
      const pipelines = pl.ok ? pl.data.pipelines.filter((p) => !p.archived) : [];
      const many = pipelines.length > 1;
      setLk({
        stages: st.ok ? st.data.filter((s) => !s.archived).map((s) => ({ value: s.id, label: s.name })) : [],
        pipelines: pipelines.map((p) => ({ value: p.id, label: p.name })),
        pipelineStages: pipelines.flatMap((p) => p.stages.filter((s) => !s.archived).map((s) => ({ value: s.id, label: many ? `${p.name}: ${s.name}` : s.name }))),
        agents: ag.ok ? ag.data.items.filter((a) => a.status === "active").map((a) => ({ value: a.id, label: a.name })) : [],
        tags: tg.ok ? tg.data.map((t) => t.name) : [],
      });
    });
    return () => { alive = false; };
  }, [workspaceId]);
  return lk;
}
