import { createContext, useContext } from "react";

export interface Room {
  /** Light the room with a colour (CSS colour string), or null for the default. */
  setScreen: (color: string | null) => void;
  setWatching: (watching: boolean) => void;
}

export const RoomContext = createContext<Room>({ setScreen: () => {}, setWatching: () => {} });
export const useRoom = () => useContext(RoomContext);
