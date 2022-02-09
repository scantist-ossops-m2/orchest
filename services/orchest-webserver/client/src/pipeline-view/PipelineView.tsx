// @ts-nocheck
import { IconButton } from "@/components/common/IconButton";
import { Layout } from "@/components/Layout";
import { useAppContext } from "@/contexts/AppContext";
import { useProjectsContext } from "@/contexts/ProjectsContext";
import { useCustomRoute } from "@/hooks/useCustomRoute";
import { useHotKeys } from "@/hooks/useHotKeys";
import { useSendAnalyticEvent } from "@/hooks/useSendAnalyticEvent";
import StyledButtonOutlined from "@/styled-components/StyledButton";
import type { PipelineJson, PipelineRun } from "@/types";
import { layoutPipeline } from "@/utils/pipeline-layout";
import {
  addOutgoingConnections,
  checkGate,
  filterServices,
  getPipelineJSONEndpoint,
  getScrollLineHeight,
  validatePipeline,
} from "@/utils/webserver-utils";
import AccountTreeOutlinedIcon from "@mui/icons-material/AccountTreeOutlined";
import AddIcon from "@mui/icons-material/Add";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import CloseIcon from "@mui/icons-material/Close";
import CropFreeIcon from "@mui/icons-material/CropFree";
import DeleteIcon from "@mui/icons-material/Delete";
import RemoveIcon from "@mui/icons-material/Remove";
import SettingsIcon from "@mui/icons-material/Settings";
import TuneIcon from "@mui/icons-material/Tune";
import ViewHeadlineIcon from "@mui/icons-material/ViewHeadline";
import VisibilityIcon from "@mui/icons-material/Visibility";
import Button from "@mui/material/Button";
import { darken } from "@mui/material/styles";
import {
  activeElementIsInput,
  collapseDoubleDots,
  fetcher,
  HEADER,
  intersectRect,
  PromiseManager,
  RefManager,
  uuidv4,
} from "@orchest/lib-utils";
import merge from "lodash.merge";
import React, { useRef } from "react";
import io from "socket.io-client";
import { siteMap } from "../Routes";
import { extractStepsFromPipelineJson, updatePipelineJson } from "./common";
import PipelineConnection from "./PipelineConnection";
import { PipelineDetails } from "./PipelineDetails";
import PipelineStep, { STEP_HEIGHT, STEP_WIDTH } from "./PipelineStep";
import { getStepSelectorRectangle, Rectangle } from "./Rectangle";
import { ServicesMenu } from "./ServicesMenu";
import { useAutoStartSession } from "./useAutoStartSession";
import {
  convertStepsToObject,
  useStepExecutionState,
} from "./useStepExecutionState";

const DRAG_CLICK_SENSITIVITY = 3;
const CANVAS_VIEW_MULTIPLE = 3;
const DOUBLE_CLICK_TIMEOUT = 300;
const INITIAL_PIPELINE_POSITION = [-1, -1];
const DEFAULT_SCALE_FACTOR = 1;

export interface IPipelineStepState {
  uuid: string;
  title: string;
  incoming_connections: string[];
  outgoing_connections?: string[];
  file_path: string;
  meta_data: {
    hidden: boolean;
    position: [number, number];
    _drag_count: number;
    _dragged: boolean;
  };
  parameters: Record<string, any>;
  environment: string;
  kernel: {
    display_name: string;
    name: string;
  };
}

export type Step = Record<string, IPipelineStepState>;

type RunStepsType = "selection" | "incoming";

type Connection = {
  startNode: HTMLElement;
  endNode?: HTMLElement;
  xEnd: number | undefined;
  yEnd: number | undefined;
  startNodeUUID: string;
  pipelineViewEl: HTMLElement;
  selected: boolean;
  endNodeUUID: string | undefined;
};

export interface IPipelineViewState {
  eventVars: {
    steps: Record<string, IPipelineStepState>;
    selectedSteps: string[];
    connections: Connection[];
    selectedConnection: Connection;
    newConnection: Connection;
  };
  // rendering state
  pipelineOrigin: number[];
  pipelineStepsHolderOffsetLeft: number;
  pipelineStepsHolderOffsetTop: number;
  pipelineOffset: [number, number];
  // misc. state
  sio: any;
  currentOngoingSaves: number;
  promiseManager: any;
  refManager: any;
  defaultDetailViewIndex: number;
  // pipelineJson?: PipelineJson;
}

const PIPELINE_RUN_STATUS_ENDPOINT = "/catch/api-proxy/api/runs/";
const PIPELINE_JOBS_STATUS_ENDPOINT = "/catch/api-proxy/api/jobs/";

const PipelineView: React.FC = () => {
  const { $ } = window;
  const { dispatch } = useProjectsContext();
  const { setAlert, setConfirm, requestBuild } = useAppContext();
  useSendAnalyticEvent("view load", { name: siteMap.pipeline.path });

  const {
    projectUuid,
    pipelineUuid,
    jobUuid: jobUuidFromRoute,
    runUuid: runUuidFromRoute,
    isReadOnly: isReadOnlyFromQueryString,
    navigateTo,
  } = useCustomRoute();

  const [isReadOnly, _setIsReadOnly] = React.useState(
    isReadOnlyFromQueryString
  );

  const [pipelineJson, setPipelineJson] = React.useState<PipelineJson>(null);

  const setIsReadOnly = (readOnly: boolean) => {
    dispatch({
      type: "SET_PIPELINE_IS_READONLY",
      payload: readOnly,
    });
    _setIsReadOnly(readOnly);
  };

  const isPipelineInitialized = React.useRef(false);

  React.useEffect(() => {
    if (!isReadOnly && !isPipelineInitialized.current) {
      initializePipelineEditListeners();
    }
  }, [isReadOnly]);

  const session = useAutoStartSession({
    projectUuid,
    pipelineUuid,
    isReadOnly,
  });

  const [isHoverEditor, setIsHoverEditor] = React.useState(false);
  const { setScope } = useHotKeys(
    {
      "pipeline-editor": {
        "ctrl+a, command+a, ctrl+enter, command+enter": (e, hotKeyEvent) => {
          if (["ctrl+a", "command+a"].includes(hotKeyEvent.key)) {
            e.preventDefault();
            state.eventVars.selectedSteps = Object.keys(state.eventVars.steps);
            updateEventVars();
          }
          if (["ctrl+enter", "command+enter"].includes(hotKeyEvent.key))
            runSelectedSteps();
        },
      },
    },
    [isHoverEditor],
    isHoverEditor
  );

  const timersRef = useRef({
    doubleClickTimeout: undefined,
    saveIndicatorTimeout: undefined,
  });

  let initialState: IPipelineViewState = {
    // eventVars are variables that are updated immediately because
    // they are part of a parent object that's passed by reference
    // and never updated. This make it possible to implement
    // complex event based UI logic with jQuery events without
    // having to deal with React state batch update logic.
    // Note: we might replace jQuery for complex event handling
    // like this in the future by using React events exclusively.
    eventVars: {
      keysDown: {},
      mouseClientX: 0,
      mouseClientY: 0,
      prevPosition: [],
      doubleClickFirstClick: false,
      isDeletingStep: false,
      selectedConnection: undefined,
      selectedItem: undefined,
      newConnection: undefined,
      draggingPipeline: false,
      openedStep: undefined,
      openedMultistep: undefined,
      selectedSteps: [],
      stepSelector: {
        active: false,
        x1: 0,
        y1: 0,
        x2: 0,
        y2: 0,
      },
      steps: {},
      scaleFactor: DEFAULT_SCALE_FACTOR,
      connections: [],
    },
    // rendering state
    pipelineOrigin: [0, 0],
    pipelineStepsHolderOffsetLeft: 0,
    pipelineStepsHolderOffsetTop: 0,
    pipelineOffset: [
      INITIAL_PIPELINE_POSITION[0],
      INITIAL_PIPELINE_POSITION[1],
    ],
    // misc. state
    sio: undefined,
    currentOngoingSaves: 0,
    promiseManager: new PromiseManager(),
    refManager: new RefManager(),
    defaultDetailViewIndex: 0,
  };

  // The save hash is used to propagate a save's side-effects to components.
  const [saveHash, setSaveHash] = React.useState<string>();
  const [pipelineCwd, setPipelineCwd] = React.useState("");

  const [pendingRuns, setPendingRuns] = React.useState<
    { uuids: string[]; type: string } | undefined
  >();

  const [pipelineRunning, setPipelineRunning] = React.useState(false);
  const [isCancellingRun, setIsCancellingRun] = React.useState(false);

  const [runUuid, setRunUuid] = React.useState(runUuidFromRoute);
  const runStatusEndpoint = jobUuidFromRoute
    ? `${PIPELINE_JOBS_STATUS_ENDPOINT}${jobUuidFromRoute}/`
    : PIPELINE_RUN_STATUS_ENDPOINT;

  const { stepExecutionState, setStepExecutionState } = useStepExecutionState(
    runUuid ? `${runStatusEndpoint}${runUuid}` : null,
    (runStatus) => {
      if (["PENDING", "STARTED"].includes(runStatus)) {
        setPipelineRunning(true);
      }

      if (["SUCCESS", "ABORTED", "FAILURE"].includes(runStatus)) {
        // make sure stale opened files are reloaded in active
        // Jupyter instance

        if (window.orchest.jupyter)
          window.orchest.jupyter.reloadFilesFromDisk();

        setPipelineRunning(false);
        setIsCancellingRun(false);
      }
    }
  );

  const [state, _setState] = React.useState<IPipelineViewState>(initialState);
  // TODO: clean up this class-component-stye setState
  const setState = (
    newState:
      | Partial<IPipelineViewState>
      | ((
          previousState: Partial<IPipelineViewState>
        ) => Partial<IPipelineViewState>)
  ) => {
    _setState((prevState) => {
      let updatedState =
        newState instanceof Function ? newState(prevState) : newState;

      return {
        ...prevState,
        ...updatedState,
      };
    });
  };

  const fetchActivePipelineRuns = () => {
    fetcher(
      `${PIPELINE_RUN_STATUS_ENDPOINT}?project_uuid=${projectUuid}&pipeline_uuid=${pipelineUuid}`
    )
      .then((data) => {
        try {
          // Note that runs are returned by the orchest-api by
          // started_time DESC. So we can just retrieve the first run.
          if (data["runs"].length > 0) {
            let run = data["runs"][0];

            setRunUuid(run.uuid);
          }
        } catch (e) {
          console.log("Error parsing return from orchest-api " + e);
        }
      })
      .catch((error) => {
        if (!error.isCanceled) {
          console.error(error);
        }
      });
  };

  const savePipeline = (callback?: () => void) => {
    if (!isReadOnly) {
      let updatedPipelineJson = updatePipelineJson(
        pipelineJson,
        state.eventVars.steps
      );

      // validate pipelineJSON
      let pipelineValidation = validatePipeline(updatedPipelineJson);

      // if invalid
      if (!pipelineValidation.valid) {
        // Just show the first error
        setAlert("Error", pipelineValidation.errors[0]);
      } else {
        // store pipeline.json
        let formData = new FormData();
        formData.append("pipeline_json", JSON.stringify(updatedPipelineJson));

        setState((state) => {
          return {
            currentOngoingSaves: state.currentOngoingSaves + 1,
          };
        });

        clearTimeout(timersRef.current.saveIndicatorTimeout);
        timersRef.current.saveIndicatorTimeout = setTimeout(() => {
          dispatch({
            type: "pipelineSetSaveStatus",
            payload: "saving",
          });
        }, 100);

        // perform POST to save
        fetcher(`/async/pipelines/json/${projectUuid}/${pipelineUuid}`, {
          method: "POST",
          body: formData,
        })
          .then(() => {
            if (callback && typeof callback == "function") {
              callback();
            }
            decrementSaveCounter();
          })
          .catch((reason) => {
            if (!reason.isCanceled) {
              decrementSaveCounter();
            }
          });
      }
    } else {
      console.error("savePipeline should be uncallable in readOnly mode.");
    }
  };

  const decrementSaveCounter = () => {
    setState((state) => {
      return {
        currentOngoingSaves: state.currentOngoingSaves - 1,
      };
    });
  };

  const getPipelineJSON = () => {
    let steps = state.eventVars.steps;
    return { ...pipelineJson, steps };
  };

  const setPipelineSteps = (steps: Record<string, IPipelineStepState>) => {
    state.eventVars.steps = steps;
    setState({ eventVars: state.eventVars });
  };

  const isJobRun = jobUuidFromRoute && runUuid;
  const jobRunQueryArgs = {
    jobUuid: jobUuidFromRoute,
    runUuid,
  };

  const openSettings = (e: React.MouseEvent) => {
    navigateTo(
      siteMap.pipelineSettings.path,
      {
        query: {
          projectUuid,
          pipelineUuid,
          ...(isJobRun ? jobRunQueryArgs : undefined),
        },
        state: { isReadOnly },
      },
      e
    );
  };

  const openLogs = (e: React.MouseEvent) => {
    navigateTo(
      siteMap.logs.path,
      {
        query: {
          projectUuid,
          pipelineUuid,
          ...(isJobRun ? jobRunQueryArgs : undefined),
        },
        state: { isReadOnly },
      },
      e
    );
  };

  const onOpenFilePreviewView = (e: React.MouseEvent, stepUuid: string) => {
    navigateTo(
      siteMap.filePreview.path,
      {
        query: {
          projectUuid,
          pipelineUuid,
          stepUuid,
          ...(isJobRun ? jobRunQueryArgs : undefined),
        },
        state: { isReadOnly },
      },
      e
    );
  };

  const openNotebook = (e: React.MouseEvent, stepUUID: string) => {
    if (session === undefined) {
      setAlert(
        "Error",
        "Please start the session before opening the Notebook in Jupyter."
      );
    } else if (session.status === "RUNNING") {
      const filePath = collapseDoubleDots(
        pipelineCwd + state.eventVars.steps[stepUUID].file_path
      ).slice(1);
      navigateTo(
        siteMap.jupyterLab.path,
        {
          query: {
            projectUuid,
            pipelineUuid,
            filePath,
          },
        },
        e
      );
    } else if (session.status === "LAUNCHING") {
      setAlert(
        "Error",
        "Please wait for the session to start before opening the Notebook in Jupyter."
      );
    } else {
      setAlert(
        "Error",
        "Please start the session before opening the Notebook in Jupyter."
      );
    }
  };

  const [isShowingServices, setIsShowingServices] = React.useState(false);

  const showServices = () => {
    setIsShowingServices(true);
  };

  const hideServices = () => {
    setIsShowingServices(false);
  };

  const initializeResizeHandlers = () => {
    $(window).resize(() => {
      pipelineSetHolderSize();
    });
  };

  // TODO: only make state.sio defined after successful
  // connect to avoid .emit()'ing to unconnected
  // sio client (emits aren't buffered).
  const connectSocketIO = () => {
    // disable polling
    setState({
      sio: io.connect("/pty", { transports: ["websocket"] }),
    });
  };

  const disconnectSocketIO = () => {
    if (state.sio) {
      state.sio.disconnect();
    }
  };

  const getConnectionByUUIDs = (startNodeUUID: string, endNodeUUID: string) => {
    for (let x = 0; x < state.eventVars.connections.length; x++) {
      if (
        state.eventVars.connections[x].startNodeUUID === startNodeUUID &&
        state.eventVars.connections[x].endNodeUUID === endNodeUUID
      ) {
        return state.eventVars.connections[x];
      }
    }
  };

  const onClickConnection = (e, startNodeUUID: string, endNodeUUID: string) => {
    if (e.button === 0 && !state.eventVars.keysDown[32]) {
      if (state.eventVars.selectedConnection) {
        state.eventVars.selectedConnection.selected = false;
      }

      deselectSteps();

      state.eventVars.selectedConnection = getConnectionByUUIDs(
        startNodeUUID,
        endNodeUUID
      );
      state.eventVars.selectedConnection.selected = true;
      updateEventVars();
    }
  };

  const createConnection = (
    outgoingJEl: HTMLElement,
    incomingJEl?: HTMLElement
  ) => {
    let newConnection: Connection = {
      startNode: outgoingJEl,
      endNode: incomingJEl,
      xEnd: undefined,
      yEnd: undefined,
      startNodeUUID: outgoingJEl.parents(".pipeline-step").attr("data-uuid"),
      pipelineViewEl: state.refManager.refs.pipelineStepsHolder,
      selected: false,
      endNodeUUID: undefined,
    };

    if (incomingJEl) {
      newConnection.endNodeUUID = incomingJEl
        .parents(".pipeline-step")
        .attr("data-uuid");
    }

    state.eventVars.connections = state.eventVars.connections.concat([
      newConnection,
    ]);
    updateEventVars();

    if (!incomingJEl) {
      state.eventVars.newConnection = newConnection;
      updateEventVars();
    }
  };

  const willCreateCycle = (startNodeUUID: string, endNodeUUID: string) => {
    // add connection temporarily
    let insertIndex =
      state.eventVars.steps[endNodeUUID].incoming_connections.push(
        startNodeUUID
      ) - 1;

    addOutgoingConnections(state.eventVars.steps);

    let whiteSet = new Set(Object.keys(state.eventVars.steps));
    let greySet = new Set();

    let cycles = false;

    while (whiteSet.size > 0) {
      // take first element left in whiteSet
      let step_uuid = whiteSet.values().next().value;

      if (dfsWithSets(step_uuid, whiteSet, greySet)) {
        cycles = true;
      }
    }

    // remote temp connection
    state.eventVars.steps[endNodeUUID].incoming_connections.splice(
      insertIndex,
      1
    );

    return cycles;
  };

  const dfsWithSets = (step_uuid, whiteSet, greySet) => {
    // move from white to grey
    whiteSet.delete(step_uuid);
    greySet.add(step_uuid);

    for (
      let x = 0;
      x < state.eventVars.steps[step_uuid].outgoing_connections.length;
      x++
    ) {
      let child_uuid = state.eventVars.steps[step_uuid].outgoing_connections[x];

      if (whiteSet.has(child_uuid)) {
        if (dfsWithSets(child_uuid, whiteSet, greySet)) {
          return true;
        }
      } else if (greySet.has(child_uuid)) {
        return true;
      }
    }

    // move from grey to black
    greySet.delete(step_uuid);
  };

  const removeConnection = (connection: Connection) => {
    setState((state) => {
      state.eventVars.connections.splice(
        state.eventVars.connections.indexOf(connection),
        1
      );
      updateEventVars();
    });

    if (connection.endNodeUUID) {
      onRemoveConnection(connection.startNodeUUID, connection.endNodeUUID);
    }
  };

  const initializePipelineEditListeners = () => {
    $(document).on("mouseup.initializePipeline", (e) => {
      if (state.eventVars.newConnection) {
        let endNodeUUID = $(e.target)
          .parents(".pipeline-step")
          .attr("data-uuid");
        let startNodeUUID = state.eventVars.newConnection.startNode
          .parents(".pipeline-step")
          .attr("data-uuid");

        // check whether drag release was on .incomming-connections class

        let dragEndedInIncomingConnectionsElement = $(e.target).hasClass(
          "incoming-connections"
        );
        let noConnectionExists = true;

        // check whether there already exists a connection
        if (dragEndedInIncomingConnectionsElement) {
          noConnectionExists =
            state.refManager.refs[
              endNodeUUID
            ].props.step.incoming_connections.indexOf(startNodeUUID) === -1;
        }

        // check whether connection will create a cycle in Pipeline graph
        let connectionCreatesCycle = false;
        if (noConnectionExists && dragEndedInIncomingConnectionsElement) {
          connectionCreatesCycle = willCreateCycle(startNodeUUID, endNodeUUID);
        }

        if (connectionCreatesCycle) {
          setAlert(
            "Error",
            "Connecting this step will create a cycle in your pipeline which is not supported."
          );
        }

        if (
          dragEndedInIncomingConnectionsElement &&
          noConnectionExists &&
          !connectionCreatesCycle
        ) {
          state.eventVars.newConnection.endNode = $(e.target);
          state.eventVars.newConnection.endNodeUUID = endNodeUUID;

          updateEventVars();

          state.refManager.refs[endNodeUUID].props.onConnect(
            startNodeUUID,
            endNodeUUID
          );
        } else {
          removeConnection(state.eventVars.newConnection);

          if (!noConnectionExists) {
            setAlert(
              "Error",
              "These steps are already connected. No new connection has been created."
            );
          }
        }

        // clean up hover effects

        $(".incoming-connections").removeClass("hover");
      }

      if (state.eventVars.newConnection !== undefined) {
        state.eventVars.newConnection = undefined;
        updateEventVars();
      }

      // clean up creating-connection class
      $(".pipeline-step").removeClass("creating-connection");
    });

    $(state.refManager.refs.pipelineStepsHolder).on(
      "mousedown",
      ".pipeline-step .outgoing-connections",
      (e) => {
        if (e.button === 0) {
          $(e.target).parents(".pipeline-step").addClass("creating-connection");
          // create connection
          createConnection($(e.target));
        }
      }
    );

    $(document).on("keydown.initializePipeline", (e) => {
      if (
        !state.eventVars.isDeletingStep &&
        !activeElementIsInput() &&
        (e.keyCode === 8 || e.keyCode === 46)
      ) {
        // Make sure that successively pressing backspace does not trigger
        // another delete.

        deleteSelectedSteps();
      }
    });

    $(document).on("keyup.initializePipeline", (e) => {
      if (!activeElementIsInput() && (e.keyCode === 8 || e.keyCode === 46)) {
        if (state.eventVars.selectedConnection) {
          e.preventDefault();

          removeConnection(state.eventVars.selectedConnection);
        }
      }
    });

    $(state.refManager.refs.pipelineStepsOuterHolder).on("mousemove", (e) => {
      if (state.eventVars.selectedItem !== undefined) {
        let delta = [
          scaleCorrectedPosition(e.clientX, state.eventVars.scaleFactor) -
            state.eventVars.prevPosition[0],
          scaleCorrectedPosition(e.clientY, state.eventVars.scaleFactor) -
            state.eventVars.prevPosition[1],
        ];

        state.eventVars.prevPosition = [
          scaleCorrectedPosition(e.clientX, state.eventVars.scaleFactor),
          scaleCorrectedPosition(e.clientY, state.eventVars.scaleFactor),
        ];

        let step = state.eventVars.steps[state.eventVars.selectedItem];

        step.meta_data._drag_count++;
        if (step.meta_data._drag_count >= DRAG_CLICK_SENSITIVITY) {
          step.meta_data._dragged = true;
          step.meta_data._drag_count = 0;
        }

        // check for spacebar
        if (!state.eventVars.draggingPipeline) {
          if (
            state.eventVars.selectedSteps.length > 1 &&
            state.eventVars.selectedSteps.indexOf(
              state.eventVars.selectedItem
            ) !== -1
          ) {
            for (let key in state.eventVars.selectedSteps) {
              let uuid = state.eventVars.selectedSteps[key];

              let singleStep = state.eventVars.steps[uuid];

              singleStep.meta_data.position[0] += delta[0];
              singleStep.meta_data.position[1] += delta[1];

              state.refManager.refs[uuid].updatePosition(
                singleStep.meta_data.position
              );
            }
          } else if (state.eventVars.selectedItem !== undefined) {
            step.meta_data.position[0] += delta[0];
            step.meta_data.position[1] += delta[1];

            state.refManager.refs[step.uuid].updatePosition(
              step.meta_data.position
            );
          }

          // Update connections state
          updateConnectionPosition();
        }
      } else if (state.eventVars.newConnection) {
        let pipelineStepHolderOffset = $(
          state.refManager.refs.pipelineStepsHolder
        ).offset();

        state.eventVars.newConnection.xEnd =
          scaleCorrectedPosition(e.clientX, state.eventVars.scaleFactor) -
          scaleCorrectedPosition(
            pipelineStepHolderOffset.left,
            state.eventVars.scaleFactor
          );
        state.eventVars.newConnection.yEnd =
          scaleCorrectedPosition(e.clientY, state.eventVars.scaleFactor) -
          scaleCorrectedPosition(
            pipelineStepHolderOffset.top,
            state.eventVars.scaleFactor
          );

        updateEventVars();

        // check for hovering over incoming-connections div
        if ($(e.target).hasClass("incoming-connections")) {
          $(e.target).addClass("hover");
        } else {
          $(".incoming-connections").removeClass("hover");
        }
      }
    });
  };

  const updateConnectionPosition = () => {
    updateEventVars();
  };

  const initializePipelineNavigationListeners = () => {
    $(state.refManager.refs.pipelineStepsHolder).on(
      "mousedown",
      ".pipeline-step",
      (e) => {
        if (e.button === 0) {
          if (!$(e.target).hasClass("outgoing-connections")) {
            let stepUUID = $(e.currentTarget).attr("data-uuid");
            state.eventVars.selectedItem = stepUUID;
            updateEventVars();
          }
        }
      }
    );

    $(document).on("mouseup.initializePipeline", (e) => {
      let stepClicked = false;
      let stepDragged = false;

      if (state.eventVars.selectedItem !== undefined) {
        let step = state.eventVars.steps[state.eventVars.selectedItem];

        if (!step.meta_data._dragged) {
          if (state.eventVars.selectedConnection) {
            deselectConnection();
          }

          if (!e.ctrlKey) {
            stepClicked = true;

            if (state.eventVars.doubleClickFirstClick) {
              state.refManager.refs[
                state.eventVars.selectedItem
              ].props.onDoubleClick(state.eventVars.selectedItem);
            } else {
              state.refManager.refs[state.eventVars.selectedItem].props.onClick(
                state.eventVars.selectedItem
              );
            }

            state.eventVars.doubleClickFirstClick = true;
            clearTimeout(timersRef.current.doubleClickTimeout);
            timersRef.current.doubleClickTimeout = setTimeout(() => {
              state.eventVars.doubleClickFirstClick = false;
            }, DOUBLE_CLICK_TIMEOUT);
          } else {
            // if clicked step is not selected, select it on Ctrl+Mouseup
            if (
              state.eventVars.selectedSteps.indexOf(
                state.eventVars.selectedItem
              ) === -1
            ) {
              state.eventVars.selectedSteps = state.eventVars.selectedSteps.concat(
                state.eventVars.selectedItem
              );

              updateEventVars();
            } else {
              // remove from selection
              state.eventVars.selectedSteps.splice(
                state.eventVars.selectedSteps.indexOf(
                  state.eventVars.selectedItem
                ),
                1
              );
              updateEventVars();
            }
          }
        } else {
          stepDragged = true;
        }

        step.meta_data._dragged = false;
        step.meta_data._drag_count = 0;
      }

      // check if step needs to be selected based on selectedSteps
      if (
        state.eventVars.stepSelector.active ||
        state.eventVars.selectedItem !== undefined
      ) {
        if (state.eventVars.selectedConnection) {
          deselectConnection();
        }

        if (
          state.eventVars.selectedSteps.length == 1 &&
          !stepClicked &&
          !stepDragged
        ) {
          selectStep(state.eventVars.selectedSteps[0]);
        } else if (state.eventVars.selectedSteps.length > 1 && !stepDragged) {
          // make sure single step detail view is closed
          closeDetailsView();

          // show multistep view
          state.eventVars.openedMultistep = true;
          updateEventVars();
        } else if (!stepDragged) {
          deselectSteps();
        }
      }

      // handle step selector
      if (state.eventVars.stepSelector.active) {
        // on mouse up trigger onClick if single step is selected
        // (only if not triggered by clickEnd)
        state.eventVars.stepSelector.active = false;
        updateEventVars();
      }

      if (stepDragged) setSaveHash(uuidv4());

      if (e.button === 0 && state.eventVars.selectedSteps.length == 0) {
        // when space bar is held make sure deselection does not occur
        // on click (as it is a drag event)

        if (
          (e.target === state.refManager.refs.pipelineStepsOuterHolder ||
            e.target === state.refManager.refs.pipelineStepsHolder) &&
          state.eventVars.draggingPipeline !== true
        ) {
          if (state.eventVars.selectedConnection) {
            deselectConnection();
          }

          deselectSteps();
        }
      }
      if (state.eventVars.selectedItem !== undefined) {
        state.eventVars.selectedItem = undefined;
        updateEventVars();
      }

      if (state.eventVars.draggingPipeline) {
        state.eventVars.draggingPipeline = false;
        updateEventVars();
      }
    });

    $(state.refManager.refs.pipelineStepsHolder).on("mousedown", (e) => {
      state.eventVars.prevPosition = [
        scaleCorrectedPosition(e.clientX, state.eventVars.scaleFactor),
        scaleCorrectedPosition(e.clientY, state.eventVars.scaleFactor),
      ];
    });

    $(document).on("mousedown.initializePipeline", (e) => {
      const serviceClass = "services-status";
      if (
        $(e.target).parents("." + serviceClass).length == 0 &&
        !$(e.target).hasClass(serviceClass)
      ) {
        hideServices();
      }
    });

    $(document).on("keydown.initializePipeline", (e) => {
      if (e.keyCode == 72 && !activeElementIsInput()) {
        centerView();
      }

      state.eventVars.keysDown[e.keyCode] = true;
    });

    $(document).on("keyup.initializePipeline", (e) => {
      state.eventVars.keysDown[e.keyCode] = false;

      if (e.keyCode) {
        $(state.refManager.refs.pipelineStepsOuterHolder).removeClass(
          "dragging"
        );

        state.eventVars.draggingPipeline = false;
        updateEventVars();
      }

      if (e.keyCode === 27) {
        if (state.eventVars.selectedConnection) {
          deselectConnection();
        }

        deselectSteps();
        closeDetailsView();
        hideServices();
      }
    });
  };

  const initializePipeline = () => {
    // Initialize should be called only once
    // state.eventVars.steps is assumed to be populated
    // called after render, assumed dom elements are also available
    // (required by i.e. connections)

    pipelineSetHolderSize();

    if (isPipelineInitialized.current) return;

    isPipelineInitialized.current = true;

    // add all existing connections (this happens only at initialization)
    for (let key in state.eventVars.steps) {
      if (state.eventVars.steps.hasOwnProperty(key)) {
        let step = state.eventVars.steps[key];

        for (let x = 0; x < step.incoming_connections.length; x++) {
          let startNodeUUID = step.incoming_connections[x];
          let endNodeUUID = step.uuid;

          let startNodeOutgoingEl = $(
            state.refManager.refs.pipelineStepsHolder
          ).find(
            ".pipeline-step[data-uuid='" +
              startNodeUUID +
              "'] .outgoing-connections"
          );

          let endNodeIncomingEl = $(
            state.refManager.refs.pipelineStepsHolder
          ).find(
            ".pipeline-step[data-uuid='" +
              endNodeUUID +
              "'] .incoming-connections"
          );

          if (startNodeOutgoingEl.length > 0 && endNodeIncomingEl.length > 0) {
            createConnection(startNodeOutgoingEl, endNodeIncomingEl);
          }
        }
      }
    }

    // initialize all listeners related to viewing/navigating the pipeline
    initializePipelineNavigationListeners();
  };

  const fetchPipelineAndInitialize = () => {
    let promises = [];

    if (!isReadOnly) {
      // fetch pipeline cwd
      promises.push(
        fetcher(
          `/async/file-picker-tree/pipeline-cwd/${projectUuid}/${pipelineUuid}`
        )
          .then((cwdPromiseResult) => {
            // relativeToAbsolutePath expects trailing / for directories
            setPipelineCwd(`${cwdPromiseResult["cwd"]}/`);
          })
          .catch((error) => {
            if (!error.isCanceled) {
              console.error(error);
            }
          })
      );
    }

    promises.push(
      fetcher(
        getPipelineJSONEndpoint(
          pipelineUuid,
          projectUuid,
          jobUuidFromRoute,
          runUuid
        )
      )
        .then((result) => {
          if (result.success) {
            const newPipelineJson = JSON.parse(result.pipeline_json);
            let newSteps = extractStepsFromPipelineJson(
              newPipelineJson,
              state.eventVars.steps
            );
            // update steps & pipelineJson
            setPipelineJson(newPipelineJson);
            setPipelineSteps(newSteps);

            dispatch({
              type: "pipelineSet",
              payload: {
                pipelineUuid,
                projectUuid,
                pipelineName: newPipelineJson.name,
              },
            });
          } else {
            console.error("Could not load pipeline.json");
            console.error(result);
          }
        })
        .catch((error) => {
          if (!error.isCanceled) {
            if (jobUuidFromRoute) {
              // This case is hit when a user tries to load a pipeline that belongs
              // to a run that has not started yet. The project files are only
              // copied when the run starts. Before start, the pipeline.json thus
              // cannot be found. Alert the user about missing pipeline and return
              // to JobView.

              setAlert(
                "Error",
                "The .orchest pipeline file could not be found. This pipeline run has not been started. Returning to Job view.",
                returnToJob
              );
            } else {
              console.error("Could not load pipeline.json");
              console.error(error);
            }
          }
        })
    );

    Promise.all(promises)
      .then(() => {
        initializePipeline();
      })
      .catch((error) => {
        console.error(error);
      });
  };

  /**
   * Get position for new step so it doesn't spawn on top of other
   * new steps.
   * @param defaultPosition Default position of new steps.
   * @param baseOffset The offset to use for X and Y.
   */
  const getNewStepPos = (defaultPosition: Array, baseOffset = 15) => {
    const pipelineJson = getPipelineJSON();

    const stepPositions = new Set();
    for (const val of Object.values(pipelineJson.steps)) {
      // Make position hashable.
      pos = String(val.meta_data.position);

      stepPositions.add(pos);
    }

    let currPos = defaultPosition;
    while (stepPositions.has(String(currPos))) {
      currPos = [currPos[0] + baseOffset, currPos[1] + baseOffset];
    }
    return currPos;
  };

  const newStep = () => {
    deselectSteps();

    fetcher(`/store/environments/${projectUuid}`).then((result) => {
      let environmentUUID = "";
      let environmentName = "";

      if (result.length > 0) {
        environmentUUID = result[0].uuid;
        environmentName = result[0].name;
      }

      let step = {
        title: "",
        uuid: uuidv4(),
        incoming_connections: [],
        file_path: "",
        kernel: {
          name: "python",
          display_name: environmentName,
        },
        environment: environmentUUID,
        parameters: {},
        meta_data: {
          position: [0, 0] as [number, number],
          _dragged: false,
          _drag_count: 0,
          hidden: true,
        },
      };

      state.eventVars.steps[step.uuid] = step;
      updateEventVars();

      selectStep(step.uuid);

      // wait for single render call
      setTimeout(() => {
        // Assumes step.uuid doesn't change
        let _step = state.eventVars.steps[step.uuid];

        // When new steps are successively created then we don't want
        // them to be spawned on top of each other. NOTE: we use the
        // same offset for X and Y position.
        const defaultPos = [
          -state.pipelineOffset[0] +
            state.refManager.refs.pipelineStepsOuterHolder.clientWidth / 2 -
            STEP_WIDTH / 2,
          -state.pipelineOffset[1] +
            state.refManager.refs.pipelineStepsOuterHolder.clientHeight / 2 -
            STEP_HEIGHT / 2,
        ];
        _step["meta_data"]["position"] = getNewStepPos(defaultPos);

        // to avoid repositioning flash (creating a step can affect the size of the viewport)
        _step["meta_data"]["hidden"] = false;
        updateEventVars();
        setSaveHash(uuidv4());
        state.refManager.refs[step.uuid].updatePosition(
          state.eventVars.steps[step.uuid].meta_data.position
        );
      }, 0);
    });
  };

  const selectStep = (pipelineStepUUID: string) => {
    state.eventVars.openedStep = pipelineStepUUID;
    state.eventVars.selectedSteps = [pipelineStepUUID];
    updateEventVars();
  };

  const onClickStepHandler = (stepUUID: string) => {
    setTimeout(() => {
      selectStep(stepUUID);
    });
  };

  const onDoubleClickStepHandler = (stepUUID: string) => {
    if (isReadOnly) {
      onOpenFilePreviewView(undefined, stepUUID);
    } else {
      openNotebook(undefined, stepUUID);
    }
  };

  const makeConnection = (sourcePipelineStepUUID, targetPipelineStepUUID) => {
    if (
      state.eventVars.steps[
        targetPipelineStepUUID
      ].incoming_connections.indexOf(sourcePipelineStepUUID) === -1
    ) {
      state.eventVars.steps[targetPipelineStepUUID].incoming_connections.push(
        sourcePipelineStepUUID
      );
    }

    updateEventVars();
    setSaveHash(uuidv4());
  };

  const onRemoveConnection = (
    sourcePipelineStepUUID,
    targetPipelineStepUUID
  ) => {
    let connectionIndex = state.eventVars.steps[
      targetPipelineStepUUID
    ].incoming_connections.indexOf(sourcePipelineStepUUID);
    if (connectionIndex !== -1) {
      state.eventVars.steps[targetPipelineStepUUID].incoming_connections.splice(
        connectionIndex,
        1
      );
    }

    updateEventVars();
    setSaveHash(uuidv4());
  };

  const deleteSelectedSteps = () => {
    // The if is to avoid the dialog appearing when no steps are
    // selected and the delete button is pressed.
    if (state.eventVars.selectedSteps.length > 0) {
      state.eventVars.isDeletingStep = true;
      updateEventVars();

      setConfirm(
        "Warning",
        `A deleted step and its logs cannot be recovered once deleted, are you sure you want to proceed?`,
        {
          onConfirm: async (resolve) => {
            closeMultistepView();
            closeDetailsView();

            // DeleteStep is going to remove the step from state.selected
            // Steps, modifying the collection while we are iterating on it.
            let stepsToRemove = state.eventVars.selectedSteps.slice();
            for (let x = 0; x < stepsToRemove.length; x++) {
              deleteStep(stepsToRemove[x]);
            }

            state.eventVars.selectedSteps = [];
            state.eventVars.isDeletingStep = false;
            updateEventVars();
            setSaveHash(uuidv4());
            resolve(true);
            return true;
          },
          onCancel: (resolve) => {
            state.eventVars.isDeletingStep = false;
            updateEventVars();
            resolve(false);
            return false;
          },
        }
      );
    }
  };

  const deleteStep = (uuid) => {
    // also delete incoming connections that contain this uuid
    for (let key in state.eventVars.steps) {
      if (state.eventVars.steps.hasOwnProperty(key)) {
        let step = state.eventVars.steps[key];

        let connectionIndex = step.incoming_connections.indexOf(uuid);
        if (connectionIndex !== -1) {
          // also delete incoming connections from GUI
          let connection = getConnectionByUUIDs(uuid, step.uuid);
          removeConnection(connection);
        }
      }
    }

    // visually delete incoming connections from GUI
    let step = state.eventVars.steps[uuid];
    let connectionsToRemove = [];

    // removeConnection modifies incoming_connections, hence the double
    // loop.
    for (let x = 0; x < step.incoming_connections.length; x++) {
      connectionsToRemove.push(
        getConnectionByUUIDs(step.incoming_connections[x], uuid)
      );
    }
    for (let connection of connectionsToRemove) {
      removeConnection(connection);
    }

    delete state.eventVars.steps[uuid];

    // if step is in selectedSteps remove
    let deletedStepIndex = state.eventVars.selectedSteps.indexOf(uuid);
    if (deletedStepIndex >= 0) {
      state.eventVars.selectedSteps.splice(deletedStepIndex, 1);
    }

    updateEventVars();
  };

  const onDetailsDelete = () => {
    let uuid = state.eventVars.openedStep;
    setConfirm(
      "Warning",
      "A deleted step and its logs cannot be recovered once deleted, are you" +
        " sure you want to proceed?",
      async (resolve) => {
        state.eventVars.openedStep = undefined;
        state.eventVars.selectedSteps = [];
        updateEventVars();
        deleteStep(uuid);
        setSaveHash(uuidv4());
        resolve(true);
        return true;
      }
    );
  };

  const updateEventVars = () => {
    setState((state) => {
      return { eventVars: state.eventVars };
    });
  };

  const onOpenNotebook = (e: React.MouseEvent) => {
    openNotebook(e, state.eventVars.openedStep);
  };

  const centerView = () => {
    state.eventVars.scaleFactor = DEFAULT_SCALE_FACTOR;
    updateEventVars();

    setState({
      pipelineOffset: [
        INITIAL_PIPELINE_POSITION[0],
        INITIAL_PIPELINE_POSITION[1],
      ],
      pipelineStepsHolderOffsetLeft: 0,
      pipelineStepsHolderOffsetTop: 0,
    });
  };

  const centerPipelineOrigin = () => {
    let pipelineStepsOuterHolderJ = $(
      state.refManager.refs.pipelineStepsOuterHolder
    );

    let pipelineStepsOuterHolderOffset = $(
      state.refManager.refs.pipelineStepsOuterHolder
    ).offset();

    let pipelineStepsHolderOffset = $(
      state.refManager.refs.pipelineStepsHolder
    ).offset();

    let centerOrigin = [
      scaleCorrectedPosition(
        pipelineStepsOuterHolderOffset.left -
          pipelineStepsHolderOffset.left +
          pipelineStepsOuterHolderJ.width() / 2,
        state.eventVars.scaleFactor
      ),
      scaleCorrectedPosition(
        pipelineStepsOuterHolderOffset.top -
          pipelineStepsHolderOffset.top +
          pipelineStepsOuterHolderJ.height() / 2,
        state.eventVars.scaleFactor
      ),
    ];

    pipelineSetHolderOrigin(centerOrigin);
  };

  const zoomOut = () => {
    centerPipelineOrigin();
    state.eventVars.scaleFactor = Math.max(
      state.eventVars.scaleFactor - 0.25,
      0.25
    );
    updateEventVars();
  };

  const zoomIn = () => {
    centerPipelineOrigin();
    state.eventVars.scaleFactor = Math.min(
      state.eventVars.scaleFactor + 0.25,
      2
    );
    updateEventVars();
  };

  const autoLayoutPipeline = () => {
    const spacingFactor = 0.7;
    const gridMargin = 20;

    const _pipelineJson = layoutPipeline(
      // Use the pipeline definition from the editor
      getPipelineJSON(),
      STEP_HEIGHT,
      (1 + spacingFactor * (STEP_HEIGHT / STEP_WIDTH)) *
        (STEP_WIDTH / STEP_HEIGHT),
      1 + spacingFactor,
      gridMargin,
      gridMargin * 4, // don't put steps behind top buttons
      gridMargin,
      STEP_HEIGHT
    );

    // TODO: make the step position state less duplicated.
    // Currently done for performance reasons.

    for (let stepUUID of Object.keys(_pipelineJson.steps)) {
      state.refManager.refs[stepUUID].updatePosition(
        _pipelineJson.steps[stepUUID].meta_data.position
      );
    }

    setPipelineJson(_pipelineJson);
    setPipelineSteps(_pipelineJson.steps);

    // and save
    setSaveHash(uuidv4());
  };

  const scaleCorrectedPosition = (position, scaleFactor) => {
    position /= scaleFactor;
    return position;
  };

  const pipelineSetHolderOrigin = (newOrigin) => {
    let pipelineStepsHolderOffset = $(
      state.refManager.refs.pipelineStepsHolder
    ).offset();

    let pipelineStepsOuterHolderOffset = $(
      state.refManager.refs.pipelineStepsOuterHolder
    ).offset();

    let initialX =
      pipelineStepsHolderOffset.left - pipelineStepsOuterHolderOffset.left;
    let initialY =
      pipelineStepsHolderOffset.top - pipelineStepsOuterHolderOffset.top;

    let translateXY = originTransformScaling(
      [...newOrigin],
      state.eventVars.scaleFactor
    );

    setState({
      pipelineOrigin: newOrigin,
      pipelineStepsHolderOffsetLeft:
        translateXY[0] + initialX - state.pipelineOffset[0],
      pipelineStepsHolderOffsetTop:
        translateXY[1] + initialY - state.pipelineOffset[1],
    });
  };

  const onPipelineStepsOuterHolderWheel = (e) => {
    let pipelineMousePosition = getMousePositionRelativeToPipelineStepHolder();

    // set origin at scroll wheel trigger
    if (
      pipelineMousePosition[0] != state.pipelineOrigin[0] ||
      pipelineMousePosition[1] != state.pipelineOrigin[1]
    ) {
      pipelineSetHolderOrigin(pipelineMousePosition);
    }

    /* mouseWheel contains information about the deltaY variable
     * WheelEvent.deltaMode can be:
     * DOM_DELTA_PIXEL = 0x00
     * DOM_DELTA_LINE = 0x01 (only used in Firefox)
     * DOM_DELTA_PAGE = 0x02 (which we'll treat identically to DOM_DELTA_LINE)
     */

    let deltaY = e.nativeEvent.deltaY;
    if (e.nativeEvent.deltaMode == 0x01 || e.nativeEvent.deltaMode == 0x02) {
      deltaY = getScrollLineHeight() * deltaY;
    }

    state.eventVars.scaleFactor = Math.min(
      Math.max(state.eventVars.scaleFactor - deltaY / 3000, 0.25),
      2
    );
    updateEventVars();
  };

  const runSelectedSteps = () => {
    runStepUUIDs(state.eventVars.selectedSteps, "selection");
  };
  const onRunIncoming = () => {
    runStepUUIDs(state.eventVars.selectedSteps, "incoming");
  };

  const cancelRun = async () => {
    if (!pipelineRunning) {
      setAlert("Error", "There is no pipeline running.");
      return;
    }

    try {
      setIsCancellingRun(true);
      await fetcher(`${PIPELINE_RUN_STATUS_ENDPOINT}${runUuid}`, {
        method: "DELETE",
      });
      setIsCancellingRun(false);
    } catch (error) {
      setAlert("Error", `Could not cancel pipeline run for runUuid ${runUuid}`);
    }
  };

  const _runStepUUIDs = (uuids: string[], type: RunStepsType) => {
    setPipelineRunning(true);

    // store pipeline.json
    fetcher<PipelineRun>(PIPELINE_RUN_STATUS_ENDPOINT, {
      method: "POST",
      headers: HEADER.JSON,
      body: JSON.stringify({
        uuids: uuids,
        project_uuid: projectUuid,
        run_type: type,
        pipeline_definition: getPipelineJSON(),
      }),
    })
      .then((result) => {
        setStepExecutionState((current) => ({
          ...current,
          ...convertStepsToObject(result),
        }));
        setRunUuid(result.uuid);
      })
      .catch((response) => {
        setPipelineRunning(false);

        setAlert(
          "Error",
          `Failed to start interactive run. ${
            response.message || "Unknown error"
          }`
        );
      });
  };

  const runStepUUIDs = (uuids: string[], type: RunStepsType) => {
    if (!session || session.status !== "RUNNING") {
      setAlert(
        "Error",
        "There is no active session. Please start the session first."
      );
      return;
    }

    if (pipelineRunning) {
      setAlert(
        "Error",
        "The pipeline is currently executing, please wait until it completes."
      );
      return;
    }

    setSaveHash(uuidv4());
    setPendingRuns({ uuids, type });
  };

  const onCloseDetails = () => {
    closeDetailsView();
  };

  const closeDetailsView = () => {
    state.eventVars.openedStep = undefined;
    updateEventVars();
  };

  const closeMultistepView = () => {
    state.eventVars.openedMultistep = undefined;
    updateEventVars();
  };

  const onCloseMultistep = () => {
    closeMultistepView();
  };

  const onDetailsChangeView = (newIndex: number) => {
    setState({
      defaultDetailViewIndex: newIndex,
    });
  };

  const onSaveDetails = (
    stepChanges: Record<string, any>,
    uuid: string,
    replace: boolean
  ) => {
    // Mutate step with changes
    if (replace) {
      // Replace works on the top level keys that are provided
      for (let key of Object.keys(stepChanges)) {
        state.eventVars.steps[uuid][key] = stepChanges[key];
      }
    } else {
      merge(state.eventVars.steps[uuid], stepChanges);
    }

    updateEventVars();
    setSaveHash(uuidv4());
  };

  const deselectSteps = () => {
    // deselecting will close the detail view
    closeDetailsView();
    onCloseMultistep();

    state.eventVars.stepSelector.x1 = Number.MIN_VALUE;
    state.eventVars.stepSelector.y1 = Number.MIN_VALUE;
    state.eventVars.stepSelector.x2 = Number.MIN_VALUE;
    state.eventVars.stepSelector.y2 = Number.MIN_VALUE;
    state.eventVars.stepSelector.active = false;

    state.eventVars.selectedSteps = [];
    updateEventVars();
  };

  const deselectConnection = () => {
    state.eventVars.selectedConnection.selected = false;
    state.eventVars.selectedConnection = undefined;
    updateEventVars();
  };

  const getSelectedSteps = () => {
    let rect = getStepSelectorRectangle(state.eventVars.stepSelector);

    let selectedSteps = [];

    // for each step perform intersect
    if (state.eventVars.stepSelector.active) {
      for (let uuid in state.eventVars.steps) {
        if (state.eventVars.steps.hasOwnProperty(uuid)) {
          let step = state.eventVars.steps[uuid];

          // guard against ref existing, in case step is being added
          if (state.refManager.refs[uuid]) {
            let stepDom = $(
              state.refManager.refs[uuid].refManager.refs.container
            );

            let stepRect = {
              x: step.meta_data.position[0],
              y: step.meta_data.position[1],
              width: stepDom.outerWidth(),
              height: stepDom.outerHeight(),
            };

            if (intersectRect(rect, stepRect)) {
              selectedSteps.push(uuid);
            }
          }
        }
      }
    }

    return selectedSteps;
  };

  const pipelineSetHolderSize = () => {
    // TODO: resize canvas based on pipeline size

    let jElStepOuterHolder = $(state.refManager.refs.pipelineStepsOuterHolder);

    if (jElStepOuterHolder.filter(":visible").length > 0) {
      $(state.refManager.refs.pipelineStepsHolder).css({
        width: jElStepOuterHolder.width() * CANVAS_VIEW_MULTIPLE,
        height: jElStepOuterHolder.height() * CANVAS_VIEW_MULTIPLE,
      });
    }
  };

  const getMousePositionRelativeToPipelineStepHolder = () => {
    let pipelineStepsolderOffset = $(
      state.refManager.refs.pipelineStepsHolder
    ).offset();

    return [
      scaleCorrectedPosition(
        state.eventVars.mouseClientX - pipelineStepsolderOffset.left,
        state.eventVars.scaleFactor
      ),
      scaleCorrectedPosition(
        state.eventVars.mouseClientY - pipelineStepsolderOffset.top,
        state.eventVars.scaleFactor
      ),
    ];
  };

  const originTransformScaling = (origin, scaleFactor) => {
    /* By multiplying the transform-origin with the scaleFactor we get the right
     * displacement for the transformed/scaled parent (pipelineStepHolder)
     * that avoids visual displacement when the origin of the
     * transformed/scaled parent is modified.
     *
     * the adjustedScaleFactor was derived by analysing the geometric behavior
     * of applying the css transform: translate(...) scale(...);.
     */

    let adjustedScaleFactor = scaleFactor - 1;
    origin[0] *= adjustedScaleFactor;
    origin[1] *= adjustedScaleFactor;
    return origin;
  };

  React.useEffect(() => {
    fetchPipelineAndInitialize();
    const keyDownHandler = (event: KeyboardEvent) => {
      if (event.key === " " && !state.eventVars.draggingPipeline) {
        state.eventVars.keysDown[32] = true;
        $(state.refManager.refs.pipelineStepsOuterHolder)
          .removeClass("dragging")
          .addClass("ready-to-drag");
        updateEventVars();
      }
    };
    const keyUpHandler = (event: KeyboardEvent) => {
      if (event.key === " ") {
        $(state.refManager.refs.pipelineStepsOuterHolder).removeClass([
          "ready-to-drag",
          "dragging",
        ]);
      }
    };

    document.body.addEventListener("keydown", keyDownHandler);
    document.body.addEventListener("keyup", keyUpHandler);
    return () => {
      document.body.removeEventListener("keydown", keyDownHandler);
      document.body.removeEventListener("keyup", keyUpHandler);
    };
  }, []);

  const enableHotKeys = () => {
    setScope("pipeline-editor");
    setIsHoverEditor(true);
  };

  const disableHotKeys = () => {
    setIsHoverEditor(false);
  };

  const onPipelineStepsOuterHolderDown = (e) => {
    state.eventVars.mouseClientX = e.clientX;
    state.eventVars.mouseClientY = e.clientY;

    if (e.button === 0) {
      if (state.eventVars.keysDown[32]) {
        // space held while clicking, means canvas drag

        $(state.refManager.refs.pipelineStepsOuterHolder)
          .addClass("dragging")
          .removeClass("ready-to-drag");
        state.eventVars.draggingPipeline = true;
      }
    }

    if (
      ($(e.target).hasClass("pipeline-steps-holder") ||
        $(e.target).hasClass("pipeline-steps-outer-holder")) &&
      e.button === 0
    ) {
      if (!state.eventVars.draggingPipeline) {
        let pipelineStepHolderOffset = $(".pipeline-steps-holder").offset();

        state.eventVars.stepSelector.active = true;
        state.eventVars.stepSelector.x1 = state.eventVars.stepSelector.x2 =
          scaleCorrectedPosition(e.clientX, state.eventVars.scaleFactor) -
          scaleCorrectedPosition(
            pipelineStepHolderOffset.left,
            state.eventVars.scaleFactor
          );
        state.eventVars.stepSelector.y1 = state.eventVars.stepSelector.y2 =
          scaleCorrectedPosition(e.clientY, state.eventVars.scaleFactor) -
          scaleCorrectedPosition(
            pipelineStepHolderOffset.top,
            state.eventVars.scaleFactor
          );

        state.eventVars.selectedSteps = getSelectedSteps();
        updateEventVars();
      }
    }

    updateEventVars();
  };

  const onPipelineStepsOuterHolderMove = (e) => {
    if (state.eventVars.stepSelector.active) {
      let pipelineStepHolderOffset = $(
        state.refManager.refs.pipelineStepsHolder
      ).offset();

      state.eventVars.stepSelector.x2 =
        scaleCorrectedPosition(e.clientX, state.eventVars.scaleFactor) -
        scaleCorrectedPosition(
          pipelineStepHolderOffset.left,
          state.eventVars.scaleFactor
        );
      state.eventVars.stepSelector.y2 =
        scaleCorrectedPosition(e.clientY, state.eventVars.scaleFactor) -
        scaleCorrectedPosition(
          pipelineStepHolderOffset.top,
          state.eventVars.scaleFactor
        );

      state.eventVars.selectedSteps = getSelectedSteps();
      updateEventVars();
    }

    if (state.eventVars.draggingPipeline) {
      let dx = e.clientX - state.eventVars.mouseClientX;
      let dy = e.clientY - state.eventVars.mouseClientY;

      setState((state) => {
        return {
          pipelineOffset: [
            state.pipelineOffset[0] + dx,
            state.pipelineOffset[1] + dy,
          ],
        };
      });
    }

    state.eventVars.mouseClientX = e.clientX;
    state.eventVars.mouseClientY = e.clientY;
  };

  const services = React.useMemo(() => {
    const allServices = jobUuidFromRoute
      ? pipelineJson?.services || null
      : session && session.user_services
      ? session.user_services
      : null;
    // Filter services based on scope
    let scope = jobUuidFromRoute ? "noninteractive" : "interactive";
    return filterServices(allServices, scope);
  }, [pipelineJson, session, jobUuidFromRoute]);

  const returnToJob = (e?: React.MouseEvent) => {
    navigateTo(
      siteMap.job.path,
      {
        query: { projectUuid, jobUuid: jobUuidFromRoute },
      },
      e
    );
  };

  let connections_list = {};
  if (state.eventVars.openedStep) {
    const step = state.eventVars.steps[state.eventVars.openedStep];
    const { incoming_connections = [] } = step;

    incoming_connections.forEach((id: string) => {
      connections_list[id] = [
        state.eventVars.steps[id].title,
        state.eventVars.steps[id].file_path,
      ];
    });
  }

  // Check if there is an incoming step (that is not part of the
  // selection).
  // This is checked to conditionally render the
  // 'Run incoming steps' button.
  let selectedStepsHasIncoming = false;
  for (let x = 0; x < state.eventVars.selectedSteps.length; x++) {
    let selectedStep = state.eventVars.steps[state.eventVars.selectedSteps[x]];
    for (let i = 0; i < selectedStep.incoming_connections.length; i++) {
      let incomingStepUUID = selectedStep.incoming_connections[i];
      if (state.eventVars.selectedSteps.indexOf(incomingStepUUID) < 0) {
        selectedStepsHasIncoming = true;
        break;
      }
    }
    if (selectedStepsHasIncoming) {
      break;
    }
  }

  const pipelineSteps = Object.entries(state.eventVars.steps).map((entry) => {
    const [uuid, step] = entry;
    const selected = state.eventVars.selectedSteps.indexOf(uuid) !== -1;
    // only add steps to the component that have been properly
    // initialized
    return (
      <PipelineStep
        key={step.uuid}
        step={step}
        selected={selected}
        ref={state.refManager.nrefs[step.uuid]}
        executionState={stepExecutionState[step.uuid] || { status: "IDLE" }}
        onConnect={makeConnection}
        onClick={onClickStepHandler}
        onDoubleClick={onDoubleClickStepHandler}
      />
    );
  });

  const connectionComponents = state.eventVars.connections.map(
    (connection, index) => {
      return (
        <PipelineConnection
          key={index}
          scaleFactor={state.eventVars.scaleFactor}
          scaleCorrectedPosition={scaleCorrectedPosition}
          onClick={onClickConnection}
          {...connection}
        />
      );
    }
  );

  React.useEffect(() => {
    // TODO: running selected steps results in saving twice
    if (saveHash !== undefined) {
      if (pendingRuns) {
        const { uuids, type } = pendingRuns;
        setPendingRuns(undefined);
        savePipeline(() => {
          _runStepUUIDs(uuids, type);
        });
      } else {
        savePipeline();
      }
    }
  }, [saveHash, pendingRuns]);

  React.useEffect(() => {
    if (state.currentOngoingSaves === 0) {
      clearTimeout(timersRef.current.saveIndicatorTimeout);
      dispatch({
        type: "pipelineSetSaveStatus",
        payload: "saved",
      });
    }
  }, [state.currentOngoingSaves]);

  React.useEffect(() => {
    dispatch({
      type: "SET_PIPELINE_IS_READONLY",
      payload: isReadOnly,
    });
    const hasActiveRun = runUuid && jobUuidFromRoute;
    const isNonPipelineRun = !hasActiveRun && isReadOnly;
    if (isNonPipelineRun) {
      // for non pipelineRun - read only check gate
      let checkGatePromise = checkGate(projectUuid);
      checkGatePromise
        .then(() => {
          setIsReadOnly(false);
        })
        .catch((result) => {
          if (result.reason === "gate-failed") {
            requestBuild(projectUuid, result.data, "Pipeline", () => {
              setIsReadOnly(false);
            });
          }
        });
    }

    // Start with hotkeys disabled
    disableHotKeys();

    connectSocketIO();
    initializeResizeHandlers();

    // Edit mode fetches latest interactive run
    if (!isReadOnly) {
      fetchActivePipelineRuns();
    }

    return () => {
      disconnectSocketIO();

      $(document).off("mouseup.initializePipeline");
      $(document).off("mousedown.initializePipeline");
      $(document).off("keyup.initializePipeline");
      $(document).off("keydown.initializePipeline");

      clearTimeout(timersRef.current.doubleClickTimeout);
      clearTimeout(timersRef.current.saveIndicatorTimeout);

      disableHotKeys();

      state.promiseManager.cancelCancelablePromises();
    };
  }, []);

  React.useEffect(() => {
    if (
      state.pipelineOffset[0] == INITIAL_PIPELINE_POSITION[0] &&
      state.pipelineOffset[1] == INITIAL_PIPELINE_POSITION[1] &&
      state.eventVars.scaleFactor == DEFAULT_SCALE_FACTOR
    ) {
      pipelineSetHolderOrigin([0, 0]);
    }
  }, [state.eventVars.scaleFactor, state.pipelineOffset]);

  const servicesButtonRef = React.useRef<HTMLButtonElement>();

  return (
    <Layout disablePadding fullHeight>
      <div className="pipeline-view">
        <div
          className="pane pipeline-view-pane"
          onMouseOver={enableHotKeys}
          onMouseLeave={disableHotKeys}
        >
          {jobUuidFromRoute && isReadOnly && (
            <div className="pipeline-actions top-left">
              <StyledButtonOutlined
                variant="outlined"
                color="secondary"
                sx={{
                  backgroundColor: (theme) => theme.palette.background.default,
                  borderColor: (theme) =>
                    darken(theme.palette.background.default, 0.2),
                  "&:hover": {
                    backgroundColor: (theme) =>
                      darken(theme.palette.background.default, 0.1),
                    borderColor: (theme) =>
                      darken(theme.palette.background.default, 0.3),
                  },
                }}
                startIcon={<ArrowBackIcon />}
                onClick={returnToJob}
                onAuxClick={returnToJob}
                data-test-id="pipeline-back-to-job"
              >
                Back to job
              </StyledButtonOutlined>
            </div>
          )}

          <div className="pipeline-actions bottom-left">
            <div className="navigation-buttons">
              <IconButton
                title="Center"
                data-test-id="pipeline-center"
                onClick={centerView}
              >
                <CropFreeIcon />
              </IconButton>
              <IconButton title="Zoom out" onClick={zoomOut}>
                <RemoveIcon />
              </IconButton>
              <IconButton title="Zoom in" onClick={zoomIn}>
                <AddIcon />
              </IconButton>
              <IconButton title="Auto layout" onClick={autoLayoutPipeline}>
                <AccountTreeOutlinedIcon />
              </IconButton>
            </div>

            {!isReadOnly &&
              !pipelineRunning &&
              state.eventVars.selectedSteps.length > 0 &&
              !state.eventVars.stepSelector.active && (
                <div className="selection-buttons">
                  <Button
                    variant="contained"
                    onClick={runSelectedSteps}
                    data-test-id="interactive-run-run-selected-steps"
                  >
                    Run selected steps
                  </Button>
                  {selectedStepsHasIncoming && (
                    <Button
                      variant="contained"
                      onClick={onRunIncoming}
                      data-test-id="interactive-run-run-incoming-steps"
                    >
                      Run incoming steps
                    </Button>
                  )}
                </div>
              )}
            {!isReadOnly && pipelineRunning && (
              <div className="selection-buttons">
                <Button
                  variant="contained"
                  color="secondary"
                  onClick={cancelRun}
                  startIcon={<CloseIcon />}
                  disabled={isCancellingRun}
                  data-test-id="interactive-run-cancel"
                >
                  Cancel run
                </Button>
              </div>
            )}
          </div>

          {pipelineJson && (
            <div className={"pipeline-actions top-right"}>
              {!isReadOnly && (
                <Button
                  variant="contained"
                  color="secondary"
                  onClick={newStep}
                  startIcon={<AddIcon />}
                  data-test-id="step-create"
                >
                  NEW STEP
                </Button>
              )}

              {isReadOnly && (
                <Button
                  color="secondary"
                  startIcon={<VisibilityIcon />}
                  disabled
                >
                  Read only
                </Button>
              )}

              <Button
                variant="contained"
                color="secondary"
                onClick={openLogs}
                onAuxClick={openLogs}
                startIcon={<ViewHeadlineIcon />}
              >
                Logs
              </Button>

              <Button
                id="running-services-button"
                variant="contained"
                color="secondary"
                onClick={showServices}
                startIcon={<SettingsIcon />}
                ref={servicesButtonRef}
              >
                Services
              </Button>
              <ServicesMenu
                isOpen={isShowingServices}
                onClose={hideServices}
                anchor={servicesButtonRef}
                services={services}
              />

              <Button
                variant="contained"
                color="secondary"
                onClick={openSettings}
                startIcon={<TuneIcon />}
                data-test-id="pipeline-settings"
              >
                Settings
              </Button>
            </div>
          )}

          <div
            className="pipeline-steps-outer-holder"
            ref={state.refManager.nrefs.pipelineStepsOuterHolder}
            onMouseMove={onPipelineStepsOuterHolderMove}
            onMouseDown={onPipelineStepsOuterHolderDown}
            onWheel={onPipelineStepsOuterHolderWheel}
          >
            <div
              className="pipeline-steps-holder"
              ref={state.refManager.nrefs.pipelineStepsHolder}
              style={{
                transformOrigin: `${state.pipelineOrigin[0]}px ${state.pipelineOrigin[1]}px`,
                transform:
                  "translateX(" +
                  state.pipelineOffset[0] +
                  "px)" +
                  "translateY(" +
                  state.pipelineOffset[1] +
                  "px)" +
                  "scale(" +
                  state.eventVars.scaleFactor +
                  ")",
                left: state.pipelineStepsHolderOffsetLeft,
                top: state.pipelineStepsHolderOffsetTop,
              }}
            >
              {state.eventVars.stepSelector.active && (
                <Rectangle
                  {...getStepSelectorRectangle(state.eventVars.stepSelector)}
                />
              )}
              {pipelineSteps}
              <div className="connections">{connectionComponents}</div>
            </div>
          </div>
        </div>

        {state.eventVars.openedStep && (
          <PipelineDetails
            key={state.eventVars.openedStep}
            onSave={onSaveDetails}
            onDelete={onDetailsDelete}
            onClose={onCloseDetails}
            onOpenFilePreviewView={onOpenFilePreviewView}
            onOpenNotebook={onOpenNotebook}
            onChangeView={onDetailsChangeView}
            connections={connections_list}
            defaultViewIndex={state.defaultDetailViewIndex}
            pipeline={pipelineJson}
            pipelineCwd={pipelineCwd}
            project_uuid={projectUuid}
            job_uuid={jobUuidFromRoute}
            run_uuid={runUuid}
            sio={state.sio}
            readOnly={isReadOnly}
            step={state.eventVars.steps[state.eventVars.openedStep]}
            saveHash={state.saveHash}
          />
        )}

        {state.eventVars.openedMultistep && !isReadOnly && (
          <div className={"pipeline-actions bottom-right"}>
            <Button
              variant="contained"
              color="secondary"
              onClick={deleteSelectedSteps}
              startIcon={<DeleteIcon />}
              disabled={state.eventVars.isDeletingStep}
              data-test-id="step-delete-multi"
            >
              Delete
            </Button>
          </div>
        )}
      </div>
    </Layout>
  );
};

export default PipelineView;
