// @ts-check
import {
  uuidv4,
  makeCancelable,
  makeRequest,
  PromiseManager,
} from "@orchest/lib-utils";
import * as React from "react";

/**
 * @type {import("./types").TOrchestState}
 */
const initialState = {
  isLoading: true,
  // @TODO ADD BROWSERCONFIG CHECK (from App.jsx)
  isDrawerOpen: true,
  pipeline_uuid: undefined,
  pipelineFetchHash: null,
  pipelineName: null,
  project_uuid: undefined,
  sessionActive: false,
  readOnlyPipeline: false,
  viewShowing: "pipeline",
  pipelineSaveStatus: "saved",
};

/**
 * @param {*} state
 * @param {import("./types").TOrchestAction} action
 * @returns
 */
function reducer(state, action) {
  switch (action.type) {
    case "isLoaded":
      return { ...state, isLoading: false };
    case "clearPipeline":
      return {
        ...state,
        pipeline_uuid: undefined,
        project_uuid: undefined,
        pipelineName: undefined,
      };
    case "setPipeline":
      return { ...state, pipelineFetchHash: uuidv4(), ...action.payload };
    case "setPipelineSaveStatus":
      return { ...state, pipelineSaveStatus: action.payload };
    case "updateCurrentView":
      return { ...state, viewShowing: action.payload };
    case "updateReadOnlyState":
      return { ...state, readOnlyPipeline: action.payload };
    case "setSessionListeners":
      return { ...state, ...action.payload };
    case "clearSessionListeners":
      return {
        ...state,
        onSessionStageChange: undefined,
        onSessionShutdown: undefined,
        onSessionFetch: undefined,
      };
    case "toggleDrawer":
      // @TODO HANDLE BROSWERCONFIG CHECK
      return { ...state, isDrawerOpen: !state.isDrawerOpen };
    case "toggleSession":
      return { ...state };
    default:
      throw new Error();
  }
}

export const OrchestContext = React.createContext(null);

export const OrchestProvider = ({ config, user_config, children }) => {
  const [state, dispatch] = React.useReducer(reducer, initialState);

  React.useEffect(() => {
    if (config && user_config) {
      dispatch({ type: "isLoaded" });
    }
  }, [config, user_config]);

  return (
    <OrchestContext.Provider value={{ state, dispatch }}>
      {children}
    </OrchestContext.Provider>
  );
};
