import { contextBridge, ipcRenderer } from "electron";

import type { GdEvent, IpcRequest } from "../shared/ipc.js";
import { createGuyditorFacade } from "./facade.js";

const facade = createGuyditorFacade({
  invoke: (channel: "gd:rpc", request: IpcRequest) => ipcRenderer.invoke(channel, request),
  on: (channel: "gd:evt", listener: (event: unknown, payload: GdEvent) => void) => {
    ipcRenderer.on(channel, listener);
  },
  removeListener: (channel: "gd:evt", listener: (event: unknown, payload: GdEvent) => void) => {
    ipcRenderer.removeListener(channel, listener);
  },
});

contextBridge.exposeInMainWorld("guyditor", facade);
