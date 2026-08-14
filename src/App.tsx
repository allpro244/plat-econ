import { useEffect } from "react";
import MapView from "@/map/MapView";
import TopBar from "@/ui/TopBar";
import RightPanel from "@/ui/RightPanel";
import StartMenu from "@/ui/StartMenu";
import MapHud from "@/ui/MapHud";
import CycleDigest from "@/ui/CycleDigest";
import DeliveryCeremony from "@/ui/DeliveryCeremony";
import PrimerOffer from "@/ui/PrimerOffer";
import { bootMenu, useStore } from "@/state/store";

export default function App() {
  const loadError = useStore((s) => s.loadError);
  // THE GAME NO LONGER STARTS ITSELF. Mounting used to generate a city and
  // drop the player into it; it now checks for a named save and stops, and the
  // start screen decides what gets built. MapView stays mounted throughout —
  // it waits on `city`, which is null until somebody breaks ground.
  const playing = useStore((s) => s.phase === "playing");
  const photoFrame = useStore((s) => s.photoFrame);
  useEffect(() => {
    void bootMenu();
  }, []);
  // RightPanel (and its keybindings) unmount in photo frame — keep P/Esc here.
  useEffect(() => {
    if (!photoFrame) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "Escape" || (e.code === "KeyP" && !e.metaKey && !e.ctrlKey && !e.altKey)) {
        e.preventDefault();
        useStore.getState().setPhotoFrame(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [photoFrame]);
  return (
    <div className={"app" + (photoFrame ? " photo-frame" : "")}>
      <MapView />
      {playing && !photoFrame && <TopBar />}
      {playing && !photoFrame && <MapHud />}
      {playing && !photoFrame && <CycleDigest />}
      {!photoFrame && <RightPanel />}
      {!photoFrame && <DeliveryCeremony />}
      {playing && !photoFrame && <PrimerOffer />}
      {photoFrame && <PhotoFrameHint />}
      <Toast />
      {!playing && <StartMenu />}
      {/* The start screen carries its own copy of this, because a city that
          would not build is the one error you can still act on from there. */}
      {loadError && playing && <div className="load-error">{loadError}</div>}
    </div>
  );
}

function PhotoFrameHint() {
  const setPhotoFrame = useStore((s) => s.setPhotoFrame);
  return (
    <button
      type="button"
      className="photo-frame-hint"
      onClick={() => setPhotoFrame(false)}
      title="Exit photo frame (P or Escape)"
    >
      Photo frame · P / Esc to exit
    </button>
  );
}

function Toast() {
  const toast = useStore((s) => s.toast);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => useStore.setState({ toast: null }), 3200);
    return () => clearTimeout(t);
  }, [toast]);
  if (!toast) return null;
  return (
    <div
      className={"toast toast-" + toast.kind}
      role={toast.kind === "err" ? "alert" : "status"}
      aria-live={toast.kind === "err" ? "assertive" : "polite"}
      aria-atomic="true"
    >
      {toast.text}
    </div>
  );
}
