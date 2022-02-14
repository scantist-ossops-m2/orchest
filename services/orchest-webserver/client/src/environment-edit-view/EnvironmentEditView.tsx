import { BackButton } from "@/components/common/BackButton";
import { PageTitle } from "@/components/common/PageTitle";
import ImageBuildLog from "@/components/ImageBuildLog";
import { ImageBuildStatus } from "@/components/ImageBuildStatus";
import { Layout } from "@/components/Layout";
import { useAppContext } from "@/contexts/AppContext";
import { useCustomRoute } from "@/hooks/useCustomRoute";
import { useFetchEnvironment } from "@/hooks/useFetchEnvironment";
import { useMounted } from "@/hooks/useMounted";
import { useSendAnalyticEvent } from "@/hooks/useSendAnalyticEvent";
import { siteMap } from "@/Routes";
import type { CustomImage, Environment, EnvironmentBuild } from "@/types";
import CloseIcon from "@mui/icons-material/Close";
import MemoryIcon from "@mui/icons-material/Memory";
import TuneIcon from "@mui/icons-material/Tune";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { fetcher, hasValue, HEADER, uuidv4 } from "@orchest/lib-utils";
import "codemirror/mode/shell/shell";
import "codemirror/theme/dracula.css";
import React from "react";
import { Controlled as CodeMirror } from "react-codemirror2";
import { ContainerImagesRadioGroup } from "./ContainerImagesRadioGroup";
import { CustomImageDialog } from "./CustomImageDialog";
import { useAutoSaveEnvironment } from "./useAutoSaveEnvironment";
import { useRequestEnvironmentBuild } from "./useRequestEnvironmentBuild";

const CANCELABLE_STATUSES = ["PENDING", "STARTED"];

const validEnvironmentName = (name: string) => {
  if (!name) {
    return false;
  }
  // Negative lookbehind. Check that every " is escaped with \
  for (let x = 0; x < name.length; x++) {
    if (name[x] == '"') {
      if (x == 0) {
        return false;
      } else {
        if (name[x - 1] != "\\") {
          return false;
        }
      }
    }
  }
  return true;
};

/**
 * in this view we use auto-save with a debounced time
 * so we still need setAsSaved to ensure that user's change is saved
 */

const ENVIRONMENT_BUILDS_BASE_ENDPOINT =
  "/catch/api-proxy/api/environment-builds";

const EnvironmentEditView: React.FC = () => {
  // global states
  const {
    setAlert,
    setAsSaved,
    state: { config },
  } = useAppContext();

  useSendAnalyticEvent("view load", { name: siteMap.environment.path });

  // data from route
  const { projectUuid, environmentUuid, navigateTo } = useCustomRoute();

  // local states

  const isNewEnvironment = environmentUuid === "new";
  const {
    environment,
    setEnvironment,
    isFetchingEnvironment,
    customImage,
    setCustomImage,
  } = useFetchEnvironment({
    // if environment is new, don't pass the uuid, so this hook won't fire the request
    uuid: !isNewEnvironment ? environmentUuid : "",
    project_uuid: projectUuid,
    ...config.ENVIRONMENT_DEFAULTS,
  });

  const [
    isShowingCustomImageDialog,
    setIsShowingCustomImageDialog,
  ] = React.useState(false);

  const [ignoreIncomingLogs, setIgnoreIncomingLogs] = React.useState(false);

  const [environmentBuild, setEnvironmentBuild] = React.useState<
    EnvironmentBuild
  >(null);
  const building = React.useMemo(() => {
    return environmentBuild
      ? CANCELABLE_STATUSES.includes(environmentBuild.status)
      : false;
  }, [environmentBuild]);

  const [isCancellingBuild, setIsCancellingBuild] = React.useState(false);

  const [buildFetchHash, setBuildFetchHash] = React.useState(uuidv4());

  const environmentNameError = !validEnvironmentName(environment.name)
    ? 'Double quotation marks in the "Environment name" have to be escaped using a backslash.'
    : undefined;

  const saveEnvironment = React.useCallback(
    async (payload?: Partial<Environment>) => {
      if (environmentNameError) {
        return false;
      }
      // Saving an environment will invalidate the Jupyter <iframe>
      // TODO: perhaps this can be fixed with coordination between JLab +
      // Enterprise Gateway team.
      window.orchest.jupyter.unload();

      try {
        const environmentUuidForUpdateOrCreate = environment.uuid || "new";
        const response = await fetcher<Environment>(
          `/store/environments/${projectUuid}/${environmentUuidForUpdateOrCreate}`,
          {
            method: isNewEnvironment ? "POST" : "PUT",
            headers: HEADER.JSON,
            body: JSON.stringify({
              environment: {
                ...environment,
                ...payload,
                uuid: environmentUuidForUpdateOrCreate,
              },
            }),
          }
        );

        if (isNewEnvironment) {
          setAsSaved();
          // update the query arg environmentUuid
          navigateTo(siteMap.environment.path, {
            query: { projectUuid, environmentUuid: response.uuid },
          });
          return true;
        }
        setEnvironment(response);
        setAsSaved();
        return true;
      } catch (error) {
        setAlert("Error", `Unable to save the custom image. ${error.message}`);
        setAsSaved(false);
        return false;
      }
    },
    [
      environment,
      isNewEnvironment,
      navigateTo,
      setAsSaved,
      projectUuid,
      setAlert,
      setEnvironment,
      environmentNameError,
    ]
  );

  useAutoSaveEnvironment(
    !isFetchingEnvironment ? environment : null,
    saveEnvironment
  );

  const returnToEnvironments = (e: React.MouseEvent) => {
    navigateTo(siteMap.environments.path, { query: { projectUuid } }, e);
  };

  const onChangeName = (value: string) => {
    setAsSaved(false);
    setEnvironment((prev) => {
      return { ...prev, name: value };
    });
  };

  const onChangeBaseImage = (newImage: CustomImage) => {
    setAsSaved(false);
    setEnvironment((prev) => ({ ...prev, ...newImage }));
  };

  const onCloseCustomBaseImageDialog = () => {
    setIsShowingCustomImageDialog(false);
  };

  const onOpenCustomBaseImageDialog = () => {
    setIsShowingCustomImageDialog(true);
  };

  const {
    isRequestingToBuild,
    newEnvironmentBuild,
    requestBuildError,
    requestToBuild,
  } = useRequestEnvironmentBuild(ENVIRONMENT_BUILDS_BASE_ENDPOINT);

  React.useEffect(() => {
    if (newEnvironmentBuild) {
      setEnvironmentBuild(newEnvironmentBuild);
    }
  }, [newEnvironmentBuild]);
  React.useEffect(() => {
    if (requestBuildError) {
      setIgnoreIncomingLogs(false);
    }
  }, [requestBuildError]);

  const build = async (e: React.MouseEvent) => {
    e.nativeEvent.preventDefault();

    setIgnoreIncomingLogs(true);

    const success = await saveEnvironment();

    if (!success) return;

    requestToBuild(projectUuid, environment.uuid);
  };

  const mounted = useMounted();

  const cancelBuild = () => {
    // send DELETE to cancel ongoing build
    if (
      environmentBuild &&
      CANCELABLE_STATUSES.includes(environmentBuild.status)
    ) {
      setIsCancellingBuild(true);

      fetcher(`${ENVIRONMENT_BUILDS_BASE_ENDPOINT}/${environmentBuild.uuid}`, {
        method: "DELETE",
      })
        .then(() => {
          // immediately fetch latest status
          // NOTE: this DELETE call doesn't actually destroy the resource, that's
          // why we're querying it again.
          setBuildFetchHash(uuidv4());
        })
        .catch((error) => {
          console.error(error);
        })
        .finally(() => {
          if (mounted) setIsCancellingBuild(false);
        });
    } else {
      setAlert(
        "Error",
        "Could not cancel build, please try again in a few seconds."
      );
    }
  };

  return (
    <Layout
      toolbarElements={
        <BackButton onClick={returnToEnvironments}>
          Back to environments
        </BackButton>
      }
    >
      {!environment ? (
        <LinearProgress />
      ) : (
        <>
          <CustomImageDialog
            isOpen={isShowingCustomImageDialog}
            onClose={onCloseCustomBaseImageDialog}
            initialValue={customImage}
            saveEnvironment={saveEnvironment}
            setCustomImage={setCustomImage}
          />
          <Box
            sx={{
              height: {
                xs: "auto",
                md: "100%",
              },
              display: "flex",
              flexDirection: { xs: "column", md: "row" },
            }}
          >
            <Stack direction="column" spacing={3} sx={{ height: "100%" }}>
              <Stack direction="row" alignItems="center" spacing={2}>
                <TuneIcon />
                <PageTitle sx={{ textTransform: "uppercase" }}>
                  Environment properties
                </PageTitle>
              </Stack>
              <Paper
                elevation={3}
                sx={{
                  padding: (theme) => theme.spacing(3),
                  minWidth: (theme) => theme.spacing(48),
                  width: (theme) => ({ xs: "100%", md: theme.spacing(48) }),
                }}
              >
                <Stack direction="column" spacing={3}>
                  <TextField
                    fullWidth
                    autoFocus
                    required
                    label="Environment name"
                    error={hasValue(environmentNameError)}
                    helperText={environmentNameError}
                    onChange={(e) => onChangeName(e.target.value)}
                    value={environment.name}
                    data-test-id="environments-env-name"
                  />
                  <ContainerImagesRadioGroup
                    value={!isFetchingEnvironment && environment.base_image}
                    onChange={onChangeBaseImage}
                    customImage={customImage}
                    onOpenCustomBaseImageDialog={onOpenCustomBaseImageDialog}
                  />
                </Stack>
              </Paper>
            </Stack>
            <Box
              sx={{
                width: "100%",
                overflow: "hidden auto",
                paddingLeft: (theme) => ({
                  xs: theme.spacing(1),
                  md: theme.spacing(5),
                }),
                paddingRight: (theme) => ({
                  xs: theme.spacing(1),
                  md: theme.spacing(4),
                }),
                margin: (theme) => theme.spacing(-4, -4, -4, 0),
              }}
            >
              <Stack
                direction="column"
                spacing={3}
                sx={{
                  width: "100%",
                  marginRight: (theme) => theme.spacing(-4),
                  paddingBottom: (theme) => theme.spacing(4),
                }}
              >
                <Box sx={{ marginTop: (theme) => theme.spacing(10) }}>
                  <Typography component="h2" variant="h6">
                    Environment set-up script
                  </Typography>
                  <Typography variant="body2">
                    This will execute when you build the environment. Use it to
                    include your dependencies.
                  </Typography>
                </Box>
                <CodeMirror
                  value={environment.setup_script}
                  options={{
                    mode: "application/x-sh",
                    theme: "dracula",
                    lineNumbers: true,
                    viewportMargin: Infinity,
                  }}
                  onBeforeChange={(editor, data, value) => {
                    setEnvironment((prev) => ({
                      ...prev,
                      setup_script: value,
                    }));
                  }}
                />
                <Stack direction="row" spacing={3} alignItems="center">
                  {!isNewEnvironment && (
                    <Button
                      disabled={isRequestingToBuild || isCancellingBuild}
                      variant="contained"
                      color={!building ? "primary" : "secondary"}
                      onClick={!building ? build : cancelBuild}
                      startIcon={!building ? <MemoryIcon /> : <CloseIcon />}
                      data-test-id={
                        !building
                          ? "environment-start-build"
                          : "environments-cancel-build"
                      }
                      sx={{
                        width: (theme) => theme.spacing(28),
                        padding: (theme) => theme.spacing(1, 4),
                      }}
                    >
                      {!building ? "Build" : "Cancel build"}
                    </Button>
                  )}
                  <ImageBuildStatus build={environmentBuild} sx={{ flex: 1 }} />
                </Stack>
                {environment && !isNewEnvironment && (
                  <ImageBuildLog
                    hideDefaultStatus
                    buildRequestEndpoint={`${ENVIRONMENT_BUILDS_BASE_ENDPOINT}/most-recent/${projectUuid}/${environment.uuid}`}
                    buildsKey="environment_builds"
                    socketIONamespace={
                      config.ORCHEST_SOCKETIO_ENV_BUILDING_NAMESPACE
                    }
                    streamIdentity={`${projectUuid}-${environment.uuid}`}
                    onUpdateBuild={setEnvironmentBuild}
                    ignoreIncomingLogs={ignoreIncomingLogs}
                    build={environmentBuild}
                    buildFetchHash={buildFetchHash}
                  />
                )}
              </Stack>
            </Box>
          </Box>
        </>
      )}
    </Layout>
  );
};

export default EnvironmentEditView;
