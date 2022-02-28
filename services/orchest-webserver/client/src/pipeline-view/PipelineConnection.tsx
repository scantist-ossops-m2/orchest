import theme from "@/theme";
import { NewConnection, Position } from "@/types";
import classNames from "classnames";
import React from "react";
import { EventVarsAction } from "./useEventVars";
import { useUpdateZIndex } from "./useZIndexMax";

// set SVG properties
const lineHeight = 2;
const svgPadding = 5;
const arrowWidth = 7;

const curvedHorizontal = function (
  x1: number,
  y1: number,
  x2: number,
  y2: number
) {
  let line = [];
  let mx = x1 + (x2 - x1) / 2;

  line.push("M", x1, y1);
  line.push("C", mx, y1, mx, y2, x2, y2);

  return line.join(" ");
};

const ConnectionLine = ({
  onClick,
  selected,
  width,
  height,
  d,
}: React.SVGProps<SVGPathElement> & {
  selected: boolean;
}) => {
  return (
    <svg width={width} height={height}>
      <path
        id="path"
        stroke={selected ? theme.palette.primary.main : "#000"}
        strokeWidth={selected ? 3 : 2}
        fill="none"
        d={d}
      />
      <path
        id="path-clickable"
        onClick={onClick}
        stroke="transparent"
        strokeWidth={4}
        fill="none"
        d={d}
      />
    </svg>
  );
};

const getRenderProperties = ({
  startNodeX,
  startNodeY,
  endNodeX = startNodeX,
  endNodeY = startNodeY,
}: {
  startNodeX: number;
  startNodeY: number;
  endNodeX?: number;
  endNodeY?: number;
}) => {
  let targetX = endNodeX - startNodeX;
  let targetY = endNodeY - startNodeY;

  let xOffset = Math.min(targetX, 0);
  let yOffset = Math.min(targetY, 0);

  const translateX = startNodeX - svgPadding + xOffset;
  const translateY = startNodeY - svgPadding + yOffset - lineHeight / 2;

  let style = {
    transform: `translateX(${translateX}px) translateY(${translateY}px)`,
  };

  const width = Math.abs(targetX) + 2 * svgPadding + "px";
  const height = Math.abs(targetY) + 2 * svgPadding + "px";
  const drawn = curvedHorizontal(
    svgPadding - xOffset,
    svgPadding - yOffset,
    svgPadding + targetX - xOffset - arrowWidth,
    svgPadding + targetY - yOffset
  );

  const className = classNames(
    targetX < arrowWidth * 10 && "flipped-horizontal",
    targetY < 0 && "flipped"
  );

  return { width, height, drawn, style, className };
};

const PipelineConnectionComponent: React.FC<{
  shouldRedraw: boolean;
  isNew: boolean;
  startNodeX: number;
  startNodeY: number;
  endNodeX: number | undefined;
  endNodeY: number | undefined;
  startNodeUUID: string;
  endNodeUUID?: string;
  getPosition: (element: HTMLElement | undefined) => Position | null;
  eventVarsDispatch: React.Dispatch<EventVarsAction>;
  selected: boolean;
  movedToTop: boolean;
  zIndexMax: React.MutableRefObject<number>;
  shouldUpdate: [boolean, boolean];
  stepDomRefs: React.MutableRefObject<Record<string, HTMLDivElement>>;
  cursorControlledStep: string;
  newConnection: React.MutableRefObject<NewConnection>;
}> = ({
  shouldRedraw,
  isNew,
  startNodeX,
  endNodeX,
  endNodeY,
  startNodeY,
  getPosition,
  eventVarsDispatch,
  selected,
  movedToTop,
  zIndexMax,
  startNodeUUID,
  endNodeUUID,
  shouldUpdate,
  stepDomRefs,
  cursorControlledStep,
  newConnection,
}) => {
  const [renderProperties, setRenderProperties] = React.useState(() =>
    getRenderProperties({
      startNodeX,
      startNodeY,
      endNodeX,
      endNodeY,
    })
  );

  const [shouldUpdateStart, shouldUpdateEnd] = shouldUpdate;

  const containerRef = React.useRef<HTMLDivElement>();

  const redrawConnectionLine = React.useCallback(() => {
    const startNode = stepDomRefs.current[`${startNodeUUID}-outgoing`];
    const endNode = stepDomRefs.current[`${endNodeUUID}-incoming`];

    const startNodePosition = getPosition(startNode);
    const endNodePosition = getPosition(endNode) || {
      x: newConnection.current?.xEnd,
      y: newConnection.current?.yEnd,
    };

    setRenderProperties((current) => {
      return {
        ...current,
        ...getRenderProperties({
          startNodeX: shouldUpdateStart ? startNodePosition.x : startNodeX,
          startNodeY: shouldUpdateStart ? startNodePosition.y : startNodeY,
          endNodeX: shouldUpdateEnd ? endNodePosition.x : endNodeX,
          endNodeY: shouldUpdateEnd ? endNodePosition.y : endNodeY,
        }),
      };
    });
  }, [
    startNodeX,
    endNodeX,
    endNodeY,
    startNodeY,
    endNodeUUID,
    startNodeUUID,
    getPosition,
    stepDomRefs,
    shouldUpdateStart,
    shouldUpdateEnd,
    newConnection,
  ]);

  // Similar to PipelineStep, here we track the positions of startNode and endNode
  // via stepDomRefs, and update the SVG accordingly
  // so that we can ONLY re-render relevant connections and get away from performance penalty

  const shouldReRender =
    (cursorControlledStep || isNew) && (shouldUpdateStart || shouldUpdateEnd);

  React.useEffect(() => {
    const onMouseMove = () => {
      if (shouldReRender) {
        redrawConnectionLine();
      }
    };
    document.body.addEventListener("mousemove", onMouseMove);
    return () => document.body.removeEventListener("mousemove", onMouseMove);
  }, [redrawConnectionLine, shouldReRender]);

  React.useEffect(() => {
    if (shouldRedraw) redrawConnectionLine();
  }, [shouldRedraw, redrawConnectionLine]);

  // movedToTop: when associated step is selected
  // shouldRedraw && isNew: user is creating
  const shouldMoveToTop = shouldReRender || movedToTop || selected;

  // -1 is to ensure connection lines are beneath the step that is on focus (i.e. the top step amongst all).
  // selected means that only THIS connection is selected, we just need to make it on top of everything
  const zIndex = useUpdateZIndex(shouldMoveToTop, zIndexMax, selected ? 0 : -1);

  const onClickFun = React.useCallback(
    (e) => {
      if (e.button === 0) {
        e.stopPropagation();
        eventVarsDispatch({
          type: "SELECT_CONNECTION",
          payload: { startNodeUUID, endNodeUUID },
        });
      }
    },
    [eventVarsDispatch, startNodeUUID, endNodeUUID]
  );

  const { style, className, width, height, drawn } = renderProperties;

  return (
    <div
      data-start-uuid={startNodeUUID}
      data-end-uuid={endNodeUUID}
      className={classNames("connection", className, selected && "selected")}
      ref={containerRef}
      style={{ ...style, zIndex }}
    >
      <ConnectionLine
        selected={selected}
        onClick={onClickFun}
        width={width}
        height={height}
        d={drawn}
      />
    </div>
  );
};

export const PipelineConnection = React.memo(PipelineConnectionComponent);
