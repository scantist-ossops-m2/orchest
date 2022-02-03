import time
from contextlib import contextmanager
from enum import Enum
from typing import Any, Callable, Dict, List, Optional

import requests
from kubernetes import client

from _orchest.internals.utils import get_k8s_namespace_manifest, get_k8s_namespace_name
from app import errors, utils
from app.connections import k8s_apps_api, k8s_core_api
from app.core.sessions import _manifests


class SessionType(Enum):
    INTERACTIVE = "interactive"
    NONINTERACTIVE = "noninteractive"


def _create_session_k8s_namespace(
    session_uuid: str,
    session_type: SessionType,
    session_config: Dict[str, Any],
    wait_ready=True,
) -> None:
    """Creates a k8s namespace for the given session.

    Args:
        session_uuid: Used for the name of the namespace.
        session_config: Used for labeling the namespace with the project
            and pipeline uuid.
        session_type: Used for labeling the namespace.
        wait_ready: Wait for the namespace to be "Active" before
            returning.
    """
    manifest = get_k8s_namespace_manifest(
        session_uuid,
        {
            "session_uuid": session_uuid,
            "project_uuid": session_config["project_uuid"],
            "pipeline_uuid": session_config["pipeline_uuid"],
            "type": session_type.value,
        },
    )
    k8s_core_api.create_namespace(manifest)
    if not wait_ready:
        return
    namespace_name = manifest["metadata"]["name"]
    for _ in range(120):
        try:
            phase = k8s_core_api.read_namespace_status(namespace_name).status.phase
            if phase == "Active":
                break
        except client.ApiException as e:
            if e.status != 404:
                raise
        time.sleep(0.5)
    else:
        raise Exception(f"Could not create namespace {namespace_name}.")


def launch(
    session_uuid: str,
    session_type: SessionType,
    session_config: Dict[str, Any],
    should_abort: Optional[Callable] = None,
) -> None:
    """Starts all resources needed by the session.

    Args:
        session_uuid: UUID to identify the session k8s namespace with,
            which is where all related resources will be deployed.
        session_type: Implies which orchest session services are part
            of the session. For "noninteractive" sessions these are
            the memory-server and session-sidecar, "interactive"
            sessions also include jupyter-eg and jupyter-server. These
            services, along with any user defined service, can be
            interacted with using the functions in this module through
            their name.
        session_config: A dictionary containing the session
            configuration. Required entries: project_uuid,
            pipeline_uuid , project_dir, host_userdir,
            env_uuid_docker_id_mappings, session_type.
            user_env_variables is a required entry for noninteractive
            session type, while it's unused for interactive session
            type.  User services can be defined by passing the optional
            entry services, a dictionary mapping service names to
            service configurations. Each service is considered a "user
            service" and will be launched along with the minimum
            resources that are required by a session to run. The
            project_uuid and pipeline_uuid determine the name of the
            resources that are launched, i.e. the container names are
            based on those. The image of a service can be an "external"
            image to be pulled from a repo or an orchest environment
            image uuid prefixed by environment@, in the latter case, the
            used image depends on the env_uuid_docker_id_mappings, which
            must have an entry for said environment uuid.  Example of a
            configuration:
            {
                "project_uuid": myuuid,
                "pipeline_uuid": myuuid,
                "project_dir": mystring,
                "host_userdir": mystring,
                "user_env_variables": {
                    "A": "1",
                    "B": "hello"
                }
                "env_uuid_docker_id_mappings" : {
                    "env uuid" : "docker id"
                }
                "services": {
                    "my-little-service": {
                        "name": "my-little-service",
                        "binds": {
                            "/data": "/data",
                            "/project-dir": "/project-dir"
                        },
                        "image": "myimage",
                        "command": "mycommand",
                        "entrypoint": "myentrypoint",
                        "scope": ["interactive", "noninteractive"],
                        "ports": [80, 8080], // ports are TCP only,
                        "env_variables": {
                            "key1": "value1",
                            "key2": "value2"
                        },
                        "env_variables_inherit": ["key1", "key2"],
                    }}
            }
        should_abort: A callable that can be used to abort the
            launch logic. When the callable returns True the launch
            is interrupted. Note that no resource cleanup takes
            place, and the caller of launch should make sure to call
            the cleanup_resources method if desired.
    """
    if should_abort is None:

        def always_false(*args, **kwargs):
            return False

        should_abort = always_false

    logger = utils.get_logger()
    logger.info("Creating namespace.")
    _create_session_k8s_namespace(session_uuid, session_type, session_config)

    # Internal Orchest session services.
    orchest_session_service_k8s_deployment_manifests = []
    orchest_session_service_k8s_service_manifests = []
    if session_type in [SessionType.INTERACTIVE, SessionType.NONINTERACTIVE]:
        orchest_session_service_k8s_deployment_manifests.append(
            _manifests._get_memory_server_deployment_manifest(
                session_uuid, session_config, session_type.value
            )
        )
        if session_config.get("services", {}):
            orchest_session_service_k8s_deployment_manifests.append(
                _manifests._get_session_sidecar_deployment_manifest(
                    session_uuid, session_config, session_type.value
                )
            )
    else:
        raise ValueError(f"Invalid session type: {session_type}.")

    if session_type == SessionType.INTERACTIVE:
        (
            depl,
            serv,
        ) = _manifests._get_jupyter_enterprise_gateway_deployment_service_manifest(
            session_uuid, session_config, session_type.value
        )
        orchest_session_service_k8s_deployment_manifests.append(depl)
        orchest_session_service_k8s_service_manifests.append(serv)
        depl, serv = _manifests._get_jupyter_server_deployment_service_manifest(
            session_uuid, session_config, session_type.value
        )
        orchest_session_service_k8s_deployment_manifests.append(depl)
        orchest_session_service_k8s_service_manifests.append(serv)

    user_session_service_k8s_deployment_manifests = []
    user_session_service_k8s_service_manifests = []
    for service_config in session_config.get("services", {}).values():
        if session_type.value not in service_config["scope"]:
            continue
        dep, serv = _manifests._get_user_service_deployment_service_manifest(
            session_uuid,
            session_config,
            service_config,
            session_type.value,
        )
        user_session_service_k8s_deployment_manifests.append(dep)
        user_session_service_k8s_service_manifests.append(serv)

    logger.info("Creating Orchest session services deployments.")
    ns = get_k8s_namespace_name(session_uuid)
    for manifest in orchest_session_service_k8s_deployment_manifests:
        logger.info(f'Creating deployment {manifest["metadata"]["name"]}')
        k8s_apps_api.create_namespaced_deployment(
            ns,
            manifest,
        )

    logger.info("Creating Orchest session services k8s services.")
    for manifest in orchest_session_service_k8s_service_manifests:
        logger.info(f'Creating service {manifest["metadata"]["name"]}')
        k8s_core_api.create_namespaced_service(
            ns,
            manifest,
        )

    logger.info("Creating user session services deployments.")
    for manifest in user_session_service_k8s_deployment_manifests:
        logger.info(f'Creating deployment {manifest["metadata"]["name"]}')
        k8s_apps_api.create_namespaced_deployment(
            ns,
            manifest,
        )

    logger.info("Creating user session services k8s services.")
    for manifest in user_session_service_k8s_service_manifests:
        logger.info(f'Creating service {manifest["metadata"]["name"]}')
        k8s_core_api.create_namespaced_service(
            ns,
            manifest,
        )

    logger.info("Waiting for user and orchest session service deployments to be ready.")
    for manifest in (
        user_session_service_k8s_deployment_manifests
        + orchest_session_service_k8s_deployment_manifests
    ):
        name = manifest["metadata"]["name"]
        deployment = k8s_apps_api.read_namespaced_deployment_status(name, ns)
        while deployment.status.available_replicas != deployment.spec.replicas:
            if should_abort():
                return
            logger.info(f"Waiting for {name}.")
            time.sleep(1)
            deployment = k8s_apps_api.read_namespaced_deployment_status(name, ns)


def shutdown(session_uuid: str, wait_for_completion: bool = False):
    """Shutdowns the session."""
    cleanup_resources(session_uuid, wait_for_completion)


def cleanup_resources(session_uuid: str, wait_for_completion: bool = False):
    """Deletes all related resources."""
    # Note: we rely on the fact that deleting the namespace leads to a
    # SIGTERM to the container, which will be used to delete the
    # existing jupyterlab user config lock for interactive sessions.
    # See PR #254.
    ns = get_k8s_namespace_name(session_uuid)
    k8s_core_api.delete_namespace(ns)

    if not wait_for_completion:
        return

    for _ in range(1000):
        try:
            k8s_core_api.read_namespace_status(ns)
        except client.ApiException as e:
            if e.status == 404:
                break
            raise
        time.sleep(1)
    else:
        raise errors.SessionCleanupFailedError()


def has_busy_kernels(session_uuid: str) -> bool:
    """Tells if the session has busy kernels.

    Args:
        session_config: Requires a "project_uuid" and a
        "pipeline_uuid".

    """
    # K8S_TODO: tweak this once the jupyter k8s integration is done.
    # https://jupyter-server.readthedocs.io/en/latest/developers/rest-api.html
    ns = get_k8s_namespace_name(session_uuid)
    service_dns_name = f"jupyter-server.{ns}.svc.cluster.local"
    url = f"http://{service_dns_name}:8888/jupyter-server/api/kernels"
    response = requests.get(url, timeout=2.0)

    # Expected format: a list of dictionaries.
    # [{'id': '3af6f3b9-4358-43b9-b2dd-03b51c4f7881', 'name':
    # 'orchest-kernel-c56ab762-539c-4cce-9b1e-c4b00300ec6f',
    # 'last_activity': '2021-11-10T09:04:10.508031Z',
    # 'execution_state': 'idle', 'connections': 2}]
    kernels: List[dict] = response.json()
    return any(kernel.get("execution_state") == "busy" for kernel in kernels)


def restart_session_service(
    session_uuid: str, service_name: str, wait_for_readiness: bool = True
) -> None:
    """Restarts a session service by name.

    Especially for the `memory-server` this comes in handy. Because
    the user should be able to clear the server. Which internally we
    do by restarting it, since clearing would also lose all state.
    Note that restarting the `memory-server` resets its eviction
    state, which is exactly what we want.

    """
    ns = get_k8s_namespace_name(session_uuid)
    old_replicas = k8s_apps_api.read_namespaced_deployment_status(
        service_name, ns
    ).spec.replicas
    k8s_apps_api.patch_namespaced_deployment_scale(
        service_name, ns, {"spec": {"replicas": 0}}
    )
    k8s_apps_api.patch_namespaced_deployment_scale(
        service_name, ns, {"spec": {"replicas": old_replicas}}
    )

    if wait_for_readiness:
        deployment = k8s_apps_api.read_namespaced_deployment_status(service_name, ns)
        while deployment.status.available_replicas != deployment.spec.replicas:
            time.sleep(1)
            deployment = k8s_apps_api.read_namespaced_deployment_status(
                service_name, ns
            )


@contextmanager
def launch_noninteractive_session(
    session_uuid: str,
    session_config: Dict[str, Any],
    should_abort: Optional[Callable] = None,
) -> None:
    """Launches a non-interactive session for a particular pipeline.

    Exiting the context leads to a shutdown of the session.

    Args:
        See args of "launch".

    Yields:
        None

    """
    try:
        launch(session_uuid, SessionType.NONINTERACTIVE, session_config, should_abort)
        yield None
    finally:
        shutdown(session_uuid)
