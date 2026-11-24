import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type DeviceSim } from "../api";
import { simName } from "../format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const SET_BY: Record<string, string> = { SIM: "read from SIM", USER: "entered by rep", ADMIN: "set by admin" };

/** The SIMs seen on a phone and the number of each; admins can set or correct a number. */
export function DeviceSims({ deviceId, sims, isAdmin }: { deviceId: string; sims: DeviceSim[]; isAdmin: boolean }) {
  if (sims.length === 0) return null;
  return (
    <div className="mt-3 space-y-1.5 border-t pt-3 text-sm">
      <div className="text-muted-foreground">Phone numbers</div>
      {sims.map((s) => <SimRow key={s.key} deviceId={deviceId} sim={s} isAdmin={isAdmin} />)}
    </div>
  );
}

function SimRow({ deviceId, sim, isAdmin }: { deviceId: string; sim: DeviceSim; isAdmin: boolean }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(sim.number ?? "");
  const save = useMutation({
    mutationFn: () => api<void>(`/api/devices/${deviceId}/sims`, { method: "PUT", body: { simKey: sim.key, number: value.trim() || null } }),
    onSuccess: () => {
      setEditing(false);
      void qc.invalidateQueries({ queryKey: ["devices"] });
    },
  });
  const name = simName(sim.slot, sim.carrier) ?? "SIM";

  if (editing) {
    return (
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <span className="text-muted-foreground">{name}</span>
        <Input className="h-8 w-40" type="tel" value={value} onChange={(e) => setValue(e.target.value)} placeholder="98xxxxxxxx" autoFocus />
        <Button size="sm" type="submit" disabled={save.isPending}>Save</Button>
        <Button size="sm" variant="ghost" type="button" onClick={() => setEditing(false)}>Cancel</Button>
        {save.error && <span className="w-full text-xs text-destructive">{(save.error as Error).message}</span>}
      </form>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="text-muted-foreground">{name}</span>
      <span className={sim.number ? "font-medium tabular-nums" : "text-amber-700"}>{sim.number ?? "Number not set"}</span>
      {sim.numberSetBy && <span className="text-xs text-muted-foreground">({SET_BY[sim.numberSetBy] ?? sim.numberSetBy})</span>}
      {sim.isNew && <Badge variant="amber">New SIM</Badge>}
      {isAdmin && (
        <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => { setValue(sim.number ?? ""); setEditing(true); }}>
          {sim.number ? "Edit" : "Set"}
        </Button>
      )}
    </div>
  );
}
