const state = {
  token: '',
  processes: [],
  view: 'listening',
  protocol: 'ALL',
  query: '',
  loading: false,
  initialized: false,
  stopped: false,
  target: null,
  targets: [],
  batchMode: false,
  selectedPids: new Set(),
  refreshTimer: null,
  toastTimer: null,
};

const elements = {
  listeningCount: document.querySelector('#listeningCount'),
  endpointCount: document.querySelector('#endpointCount'),
  nodeCount: document.querySelector('#nodeCount'),
  updatedAt: document.querySelector('#updatedAt'),
  resultSummary: document.querySelector('#resultSummary'),
  listeningTabCount: document.querySelector('#listeningTabCount'),
  nodeTabCount: document.querySelector('#nodeTabCount'),
  processRows: document.querySelector('#processRows'),
  processTable: document.querySelector('#processTable'),
  emptyState: document.querySelector('#emptyState'),
  emptyTitle: document.querySelector('#emptyTitle'),
  emptyDescription: document.querySelector('#emptyDescription'),
  refreshButton: document.querySelector('#refreshButton'),
  batchTerminateButton: document.querySelector('#batchTerminateButton'),
  batchTerminateLabel: document.querySelector('#batchTerminateLabel'),
  selectAllRows: document.querySelector('#selectAllRows'),
  autoRefresh: document.querySelector('#autoRefresh'),
  refreshInterval: document.querySelector('#refreshInterval'),
  searchInput: document.querySelector('#searchInput'),
  protocolFilter: document.querySelector('#protocolFilter'),
  errorBanner: document.querySelector('#errorBanner'),
  errorMessage: document.querySelector('#errorMessage'),
  dismissError: document.querySelector('#dismissError'),
  terminateDialog: document.querySelector('#terminateDialog'),
  terminateEyebrow: document.querySelector('#terminateEyebrow'),
  terminateTitle: document.querySelector('#terminateTitle'),
  targetName: document.querySelector('#targetName'),
  targetPid: document.querySelector('#targetPid'),
  targetCommand: document.querySelector('#targetCommand'),
  confirmTerminate: document.querySelector('#confirmTerminate'),
  shutdownButton: document.querySelector('#shutdownButton'),
  shutdownDialog: document.querySelector('#shutdownDialog'),
  confirmShutdown: document.querySelector('#confirmShutdown'),
  serviceClosed: document.querySelector('#serviceClosed'),
  toast: document.querySelector('#toast'),
};

function createElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function setButtonLoading(button, loading, loadingText, normalText) {
  button.disabled = loading;
  button.textContent = loading ? loadingText : normalText;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `请求失败（HTTP ${response.status}）`);
    error.details = payload.details || '';
    throw error;
  }
  return payload;
}

function mutationOptions(body) {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Local-Session': state.token,
    },
    body: JSON.stringify(body),
  };
}

function formatDateTime(value, includeSeconds = false) {
  if (!value) return '未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: includeSeconds ? '2-digit' : undefined,
    hour12: false,
  }).format(date);
}

function getProjectPath(processInfo) {
  if (processInfo.isManager) return '端口管家（当前项目）';
  const command = processInfo.commandLine || '';
  const normalized = command.toLowerCase();
  const nodeModulesIndex = normalized.indexOf('\\node_modules\\');

  if (nodeModulesIndex > -1) {
    const prefix = command.slice(0, nodeModulesIndex);
    const driveMatches = [...prefix.matchAll(/[a-z]:\\/gi)];
    const lastDrive = driveMatches.at(-1);
    if (lastDrive) return prefix.slice(lastDrive.index).replace(/^["']/, '').trim();
  }

  const scriptPaths = [...command.matchAll(/[a-z]:\\[^"\r\n]+?\.(?:cjs|mjs|js|ts)(?=["'\s]|$)/gi)];
  const scriptPath = scriptPaths.at(-1)?.[0];
  if (scriptPath) {
    const separator = scriptPath.lastIndexOf('\\');
    if (separator > 2) return scriptPath.slice(0, separator);
  }

  if (!processInfo.isNode && processInfo.executablePath) return processInfo.executablePath;
  return null;
}

function endpointText(endpoint) {
  const address = endpoint.localAddress.includes(':') ? `[${endpoint.localAddress}]` : endpoint.localAddress;
  return `${address}:${endpoint.localPort}`;
}

function searchableText(processInfo) {
  const endpoints = processInfo.endpoints
    .map((endpoint) => `${endpoint.protocol} ${endpoint.localAddress} ${endpoint.localPort}`)
    .join(' ');
  return [
    processInfo.pid,
    processInfo.name,
    processInfo.executablePath,
    processInfo.commandLine,
    processInfo.parentName,
    processInfo.parentCommandLine,
    getProjectPath(processInfo),
    endpoints,
  ]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase('zh-CN');
}

function filteredProcesses() {
  const normalizedQuery = state.query.trim().toLocaleLowerCase('zh-CN');
  return state.processes
    .filter((processInfo) => (state.view === 'node' ? processInfo.isNode : processInfo.endpoints.length > 0))
    .filter((processInfo) => {
      if (state.protocol === 'ALL') return true;
      return processInfo.endpoints.some((endpoint) => endpoint.protocol === state.protocol);
    })
    .filter((processInfo) => !normalizedQuery || searchableText(processInfo).includes(normalizedQuery))
    .sort((left, right) => {
      const leftPort = Math.min(...left.endpoints.map((item) => item.localPort), Number.MAX_SAFE_INTEGER);
      const rightPort = Math.min(...right.endpoints.map((item) => item.localPort), Number.MAX_SAFE_INTEGER);
      return leftPort - rightPort || left.name.localeCompare(right.name, 'zh-CN') || left.pid - right.pid;
    });
}

function renderSkeleton() {
  elements.processRows.replaceChildren();
  elements.processTable.hidden = false;
  elements.emptyState.hidden = true;
  for (let rowIndex = 0; rowIndex < 4; rowIndex += 1) {
    const row = createElement('tr', 'skeleton-row');
    for (let columnIndex = 0; columnIndex < 7; columnIndex += 1) {
      const cell = document.createElement('td');
      cell.append(createElement('div', 'skeleton-line'));
      cell.append(createElement('div', 'skeleton-line short'));
      row.append(cell);
    }
    elements.processRows.append(row);
  }
}

function selectionCell(processInfo) {
  const cell = createElement('td', 'selection-cell');
  cell.dataset.label = '选择';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'row-checkbox';
  checkbox.checked = state.selectedPids.has(processInfo.pid);
  checkbox.disabled = !processInfo.canTerminate;
  checkbox.setAttribute('aria-label', `选择 ${processInfo.name}，PID ${processInfo.pid}`);
  if (!processInfo.canTerminate) checkbox.title = processInfo.protectionReason || '该进程不可结束';
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) state.selectedPids.add(processInfo.pid);
    else state.selectedPids.delete(processInfo.pid);
    renderTable();
  });
  cell.append(checkbox);
  return cell;
}

function processCell(processInfo) {
  const cell = document.createElement('td');
  cell.dataset.label = '进程';
  const title = createElement('div', 'process-title');
  title.append(createElement('strong', '', processInfo.name));
  title.append(createElement('span', 'pid', `PID ${processInfo.pid}`));
  if (processInfo.isManager) title.append(createElement('span', 'manager-badge', '管理服务'));
  cell.append(title);

  const executable = processInfo.executablePath || '路径不可见，可能需要管理员权限';
  const pathElement = createElement('span', 'process-path', executable);
  pathElement.title = executable;
  cell.append(pathElement);
  return cell;
}

function endpointCell(processInfo) {
  const cell = document.createElement('td');
  cell.dataset.label = '监听地址';
  const endpoints = processInfo.endpoints.filter(
    (endpoint) => state.protocol === 'ALL' || endpoint.protocol === state.protocol,
  );

  if (endpoints.length === 0) {
    cell.append(createElement('span', 'no-data', '未监听端口'));
    return cell;
  }

  const list = createElement('div', 'endpoint-list');
  endpoints.slice(0, 4).forEach((endpoint) => {
    const item = createElement('div', 'endpoint-item');
    item.append(createElement('span', `protocol-badge ${endpoint.protocol === 'UDP' ? 'udp' : ''}`, endpoint.protocol));
    const value = endpointText(endpoint);
    const chip = createElement('span', 'endpoint-chip', value);
    chip.title = value;
    item.append(chip);
    list.append(item);
  });
  if (endpoints.length > 4) list.append(createElement('span', 'more-endpoints', `另有 ${endpoints.length - 4} 个端口`));
  cell.append(list);
  return cell;
}

function commandCell(processInfo) {
  const cell = document.createElement('td');
  cell.dataset.label = '项目与命令';
  const projectPath = getProjectPath(processInfo);
  const project = createElement('strong', '', projectPath || (processInfo.isNode ? '未识别项目目录' : '程序命令'));
  project.title = projectPath || '';
  cell.append(project);

  const command = processInfo.commandLine || '命令行不可见，可能需要管理员权限';
  const commandElement = createElement('code', 'command-line', command);
  commandElement.title = command;
  cell.append(commandElement);
  return cell;
}

function parentCell(processInfo) {
  const cell = document.createElement('td');
  cell.dataset.label = '父进程';
  if (!processInfo.parentName) {
    cell.append(createElement('span', 'no-data', '未知'));
    return cell;
  }
  cell.append(createElement('strong', '', processInfo.parentName));
  if (processInfo.parentPid) cell.append(createElement('span', 'pid', `PID ${processInfo.parentPid}`));
  if (processInfo.parentCommandLine) {
    const parentCommand = createElement('code', 'parent-command', processInfo.parentCommandLine);
    parentCommand.title = processInfo.parentCommandLine;
    cell.append(parentCommand);
  }
  return cell;
}

function timeCell(processInfo) {
  const cell = document.createElement('td');
  cell.dataset.label = '启动时间';
  cell.append(createElement('strong', '', formatDateTime(processInfo.startedAt)));
  if (processInfo.startedAt) {
    const ageMs = Date.now() - new Date(processInfo.startedAt).getTime();
    const ageMinutes = Math.max(0, Math.floor(ageMs / 60_000));
    const ageText = ageMinutes < 60
      ? `${ageMinutes} 分钟前`
      : ageMinutes < 1440
        ? `${Math.floor(ageMinutes / 60)} 小时前`
        : `${Math.floor(ageMinutes / 1440)} 天前`;
    cell.append(createElement('span', 'time-secondary', ageText));
  }
  return cell;
}

function actionCell(processInfo) {
  const cell = createElement('td', 'action-cell');
  cell.dataset.label = '操作';
  if (!processInfo.canTerminate) {
    const label = createElement('span', 'protected-label', processInfo.isManager ? '服务自身' : '系统保护');
    label.title = processInfo.protectionReason || '';
    cell.append(label);
    return cell;
  }

  const button = createElement('button', 'terminate-button', '× 结束');
  button.type = 'button';
  button.setAttribute('aria-label', `结束进程 ${processInfo.name}，PID ${processInfo.pid}`);
  button.addEventListener('click', () => openTerminateDialog(processInfo));
  cell.append(button);
  return cell;
}

function renderTable() {
  const visible = filteredProcesses();
  elements.processRows.replaceChildren();

  const scopeName = state.view === 'node' ? 'Node 进程' : '监听进程';
  elements.resultSummary.textContent = `显示 ${visible.length} 个${scopeName}，共读取 ${state.processes.length} 个相关进程`;

  if (visible.length === 0) {
    elements.processTable.hidden = true;
    elements.emptyState.hidden = false;
    const hasFilters = Boolean(state.query.trim()) || state.protocol !== 'ALL';
    elements.emptyTitle.textContent = hasFilters ? '没有匹配结果' : `当前没有${scopeName}`;
    elements.emptyDescription.textContent = hasFilters ? '调整搜索词或协议筛选后重试。' : '刷新列表后会自动显示新进程。';
    updateSelectionControls(visible);
    return;
  }

  elements.processTable.hidden = false;
  elements.emptyState.hidden = true;
  visible.forEach((processInfo) => {
    const row = document.createElement('tr');
    row.classList.toggle('is-selected', state.selectedPids.has(processInfo.pid));
    row.append(
      selectionCell(processInfo),
      processCell(processInfo),
      endpointCell(processInfo),
      commandCell(processInfo),
      parentCell(processInfo),
      timeCell(processInfo),
      actionCell(processInfo),
    );
    elements.processRows.append(row);
  });
  updateSelectionControls(visible);
}

function updateSelectionControls(visible = filteredProcesses()) {
  const selectable = visible.filter((processInfo) => processInfo.canTerminate);
  const selectedVisibleCount = selectable.filter((processInfo) => state.selectedPids.has(processInfo.pid)).length;
  elements.selectAllRows.disabled = selectable.length === 0;
  elements.selectAllRows.checked = selectable.length > 0 && selectedVisibleCount === selectable.length;
  elements.selectAllRows.indeterminate = selectedVisibleCount > 0 && selectedVisibleCount < selectable.length;

  const selectedCount = state.selectedPids.size;
  elements.batchTerminateButton.disabled = selectedCount === 0;
  elements.batchTerminateLabel.textContent = selectedCount > 0 ? `全部结束（${selectedCount}）` : '全部结束';
}

function updateSummary(generatedAt) {
  const listening = state.processes.filter((item) => item.endpoints.length > 0);
  const nodes = state.processes.filter((item) => item.isNode);
  const endpointCount = state.processes.reduce((total, item) => total + item.endpoints.length, 0);
  elements.listeningCount.textContent = String(listening.length);
  elements.endpointCount.textContent = String(endpointCount);
  elements.nodeCount.textContent = String(nodes.length);
  elements.updatedAt.textContent = `${formatDateTime(generatedAt, true)} · 自动刷新${elements.autoRefresh.checked ? '已开启' : '已暂停'}`;
  elements.listeningTabCount.textContent = String(listening.length);
  elements.nodeTabCount.textContent = String(nodes.length);
}

function showError(error) {
  const details = error.details ? ` ${error.details}` : '';
  elements.errorMessage.textContent = `${error.message}${details}`;
  elements.errorBanner.hidden = false;
}

function clearError() {
  elements.errorBanner.hidden = true;
  elements.errorMessage.textContent = '';
}

function showToast(message) {
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  state.toastTimer = setTimeout(() => {
    elements.toast.hidden = true;
  }, 3200);
}

function scheduleRefresh() {
  clearTimeout(state.refreshTimer);
  if (!elements.autoRefresh.checked || state.stopped) return;
  const delay = Number(elements.refreshInterval.value) || 5000;
  state.refreshTimer = setTimeout(() => loadProcesses(false), delay);
}

async function loadProcesses(force = false) {
  if (state.loading || state.stopped) return;
  state.loading = true;
  elements.refreshButton.disabled = true;
  elements.refreshButton.classList.add('is-loading');
  if (!state.initialized) renderSkeleton();

  try {
    const snapshot = await fetchJson(`/api/processes${force ? '?force=1' : ''}`);
    state.processes = snapshot.processes;
    const eligiblePids = new Set(state.processes.filter((item) => item.canTerminate).map((item) => item.pid));
    state.selectedPids.forEach((pid) => {
      if (!eligiblePids.has(pid)) state.selectedPids.delete(pid);
    });
    state.initialized = true;
    clearError();
    updateSummary(snapshot.generatedAt);
    renderTable();
  } catch (error) {
    showError(error);
    if (!state.initialized) {
      elements.processRows.replaceChildren();
      elements.processTable.hidden = true;
      elements.emptyState.hidden = false;
      elements.emptyTitle.textContent = '无法读取进程';
      elements.emptyDescription.textContent = '检查错误信息后点击刷新重试。';
    }
  } finally {
    state.loading = false;
    elements.refreshButton.disabled = false;
    elements.refreshButton.classList.remove('is-loading');
    scheduleRefresh();
  }
}

function openTerminateDialog(processInfo) {
  state.target = processInfo;
  state.targets = [processInfo];
  state.batchMode = false;
  elements.terminateEyebrow.textContent = '危险操作';
  elements.terminateTitle.textContent = '结束进程';
  elements.targetName.textContent = processInfo.name;
  elements.targetPid.textContent = `PID ${processInfo.pid}`;
  elements.targetCommand.textContent = processInfo.commandLine || processInfo.executablePath || '命令行不可见';
  elements.targetCommand.title = elements.targetCommand.textContent;
  elements.targetCommand.parentElement.classList.remove('is-batch');
  elements.terminateDialog.querySelector('input[value="single"]').checked = true;
  elements.confirmTerminate.textContent = '确认结束';
  elements.terminateDialog.showModal();
}

function openBatchTerminateDialog() {
  const targets = state.processes.filter((processInfo) => state.selectedPids.has(processInfo.pid) && processInfo.canTerminate);
  if (targets.length === 0) return;

  state.target = null;
  state.targets = targets;
  state.batchMode = true;
  elements.terminateEyebrow.textContent = '批量危险操作';
  elements.terminateTitle.textContent = '全部结束选中进程';
  elements.targetName.textContent = `已选择 ${targets.length} 个进程`;
  elements.targetPid.textContent = targets.map((item) => `PID ${item.pid}`).join('、');
  const summary = targets.slice(0, 8).map((item) => `${item.name}（${item.pid}）`).join('，');
  elements.targetCommand.textContent = targets.length > 8 ? `${summary}，另有 ${targets.length - 8} 个` : summary;
  elements.targetCommand.title = elements.targetCommand.textContent;
  elements.targetCommand.parentElement.classList.add('is-batch');
  elements.terminateDialog.querySelector('input[value="single"]').checked = true;
  elements.confirmTerminate.textContent = '确认全部结束';
  elements.terminateDialog.showModal();
}

async function confirmTerminate() {
  if (state.targets.length === 0) return;
  const targets = [...state.targets];
  const isBatch = state.batchMode;
  const tree = elements.terminateDialog.querySelector('input[name="killMode"]:checked').value === 'tree';
  const normalLabel = isBatch ? '确认全部结束' : '确认结束';
  setButtonLoading(elements.confirmTerminate, true, '正在结束...', normalLabel);

  try {
    if (isBatch) {
      const result = await fetchJson('/api/processes/terminate-batch', mutationOptions({
        targets: targets.map((target) => ({ pid: target.pid, startedAt: target.startedAt })),
        tree,
      }));
      const completedPids = new Set([
        ...result.succeeded.map((item) => item.pid),
        ...result.coveredByTree.map((item) => item.pid),
      ]);
      completedPids.forEach((pid) => state.selectedPids.delete(pid));
      const completedCount = completedPids.size;
      if (result.failed.length > 0) {
        const failedPids = result.failed.map((item) => `PID ${item.pid}`).join('、');
        showError(new Error(`已结束 ${completedCount} 个进程，${result.failed.length} 个失败：${failedPids}`));
      } else {
        showToast(`已结束 ${completedCount} 个选中进程${tree ? '及其进程树' : ''}`);
      }
    } else {
      const target = targets[0];
      await fetchJson('/api/processes/terminate', mutationOptions({
        pid: target.pid,
        startedAt: target.startedAt,
        tree,
      }));
      state.selectedPids.delete(target.pid);
      showToast(`已结束 ${target.name}（PID ${target.pid}）${tree ? '及其进程树' : ''}`);
    }
    elements.terminateDialog.close();
    state.target = null;
    state.targets = [];
    state.batchMode = false;
    await new Promise((resolve) => setTimeout(resolve, 450));
    await loadProcesses(true);
  } catch (error) {
    showError(error);
  } finally {
    setButtonLoading(elements.confirmTerminate, false, '正在结束...', normalLabel);
  }
}

async function confirmShutdown() {
  setButtonLoading(elements.confirmShutdown, true, '正在关闭...', '关闭服务');
  try {
    await fetchJson('/api/shutdown', mutationOptions({ confirm: 'SHUTDOWN' }));
    state.stopped = true;
    clearTimeout(state.refreshTimer);
    elements.shutdownDialog.close();
    elements.serviceClosed.hidden = false;
  } catch (error) {
    showError(error);
    setButtonLoading(elements.confirmShutdown, false, '正在关闭...', '关闭服务');
  }
}

function setView(view) {
  state.view = view;
  document.querySelectorAll('[data-view]').forEach((tab) => {
    const active = tab.dataset.view === view;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  renderTable();
}

function bindEvents() {
  elements.refreshButton.addEventListener('click', () => loadProcesses(true));
  elements.batchTerminateButton.addEventListener('click', openBatchTerminateDialog);
  elements.selectAllRows.addEventListener('change', () => {
    filteredProcesses()
      .filter((processInfo) => processInfo.canTerminate)
      .forEach((processInfo) => {
        if (elements.selectAllRows.checked) state.selectedPids.add(processInfo.pid);
        else state.selectedPids.delete(processInfo.pid);
      });
    renderTable();
  });
  elements.dismissError.addEventListener('click', clearError);
  elements.autoRefresh.addEventListener('change', () => {
    updateSummary(new Date().toISOString());
    scheduleRefresh();
  });
  elements.refreshInterval.addEventListener('change', scheduleRefresh);
  elements.searchInput.addEventListener('input', (event) => {
    state.query = event.target.value;
    renderTable();
  });
  elements.protocolFilter.addEventListener('change', (event) => {
    state.protocol = event.target.value;
    renderTable();
  });
  document.querySelectorAll('[data-view]').forEach((tab) => {
    tab.addEventListener('click', () => setView(tab.dataset.view));
  });
  elements.confirmTerminate.addEventListener('click', confirmTerminate);
  elements.shutdownButton.addEventListener('click', () => elements.shutdownDialog.showModal());
  elements.confirmShutdown.addEventListener('click', confirmShutdown);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !state.stopped) loadProcesses(true);
  });
  [elements.terminateDialog, elements.shutdownDialog].forEach((dialog) => {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  });
}

async function initialize() {
  bindEvents();
  try {
    const session = await fetchJson('/api/session');
    state.token = session.token;
    await loadProcesses(true);
  } catch (error) {
    showError(error);
  }
}

initialize();
