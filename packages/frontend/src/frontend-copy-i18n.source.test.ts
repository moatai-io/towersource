import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const sourceRoot = path.resolve(import.meta.dirname);

function flattenKeys(value: unknown, prefix = '', output = new Set<string>()): Set<string> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flattenKeys(child, prefix ? `${prefix}.${key}` : key, output);
    }
  } else {
    output.add(prefix);
  }
  return output;
}

function readLocale(language: 'en' | 'ko', namespace: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(sourceRoot, 'locales', language, `${namespace}.json`), 'utf8'));
}

function walkSourceFiles(dir: string, output: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['locales', 'test-stubs', 'assets'].includes(entry.name)) walkSourceFiles(fullPath, output);
      continue;
    }
    if (/\.tsx?$/.test(entry.name) && !/\.(?:test|source\.test)\.tsx?$/.test(entry.name)) {
      output.push(fullPath);
    }
  }
  return output;
}

describe('frontend copy i18n contract', () => {
  it('imports useTranslation wherever the hook is called', () => {
    const offenders = walkSourceFiles(sourceRoot).filter((file) => {
      const text = fs.readFileSync(file, 'utf8');
      return /\buseTranslation\s*\(/.test(text) && !/import\s*\{[^}]*\buseTranslation\b[^}]*\}\s*from\s*['"]react-i18next['"]/.test(text);
    }).map((file) => path.relative(sourceRoot, file));

    expect(offenders).toEqual([]);
  });

  it('formats PersonalUsageSummary token counts with the active locale', () => {
    const usage = fs.readFileSync(path.join(sourceRoot, 'components/work/PersonalUsageSummary.tsx'), 'utf8');
    expect(usage).toContain('value.toLocaleString(i18n.resolvedLanguage || i18n.language)');
    expect(usage).not.toContain("value.toLocaleString('ko-KR')");
  });

  it('routes Challenge timeline status and actions through common locale keys', () => {
    const timeline = fs.readFileSync(path.join(sourceRoot, 'components/work/ChallengeTimelinePanel.tsx'), 'utf8');
    expect(timeline).toContain("i18n.t('challenge.statusText.left', { ns: 'common', count: challenge.todoLeft })");
    expect(timeline).toContain('i18n.t(`challenge.status.${key}`');
    expect(timeline).toContain('i18n.t(`challenge.action.${key}`');
    expect(timeline).not.toContain("return '검토하고 결정하기'");
  });

  it('routes AI service status and website exposure labels through common locale keys', () => {
    const aiServices = fs.readFileSync(path.join(sourceRoot, 'features/ai-services/AIServiceHome.tsx'), 'utf8');
    expect(aiServices).toContain('i18n.t(`aiServices.status.${status}`)');
    expect(aiServices).toContain("i18n.t('aiServices.exposure.notPublished')");
    expect(aiServices).not.toContain("return '웹사이트 준비 중'");
    expect(aiServices).not.toContain("return '비밀번호로 보호됨'");
  });

  it('routes SchedulePanel intervals, relative time, and process status through schedule locale keys', () => {
    const schedulePanel = fs.readFileSync(path.join(sourceRoot, 'components/schedule/SchedulePanel.tsx'), 'utf8');
    expect(schedulePanel).toContain("t('intervalMinutes', { count: minutes })");
    expect(schedulePanel).toContain("'relativeTime.minutesAgo'");
    expect(schedulePanel).toContain('`processStepStatus.${key}`');
    expect(schedulePanel).not.toContain("case 'completed': return '완료'");
  });

  it('routes ProjectHome relative time and workstream status through the files locale', () => {
    const projectHome = fs.readFileSync(path.join(sourceRoot, 'components/files/ProjectHome.tsx'), 'utf8');
    expect(projectHome).toContain("fileText('projectHome.relativeTime.minutesAgo', { count: minutes })");
    expect(projectHome).toContain('projectHome.workstreamStatus.${');
    expect(projectHome).toContain('i18n.resolvedLanguage || i18n.language');
    expect(projectHome).not.toContain("return '방금 전'");
    expect(projectHome).not.toContain("return '완료'");
  });

  it('routes Admin credential connection formatters through the admin locale', () => {
    const adminPanel = fs.readFileSync(path.join(sourceRoot, 'components/admin/AdminPanel.tsx'), 'utf8');
    expect(adminPanel).toContain("return adminText(`credentialConnections.purpose.${purpose}`)");
    expect(adminPanel).toContain("adminText('credentialConnections.usageScope.projectCount'");
    expect(adminPanel).toContain("adminText('credentialConnections.warning.syncTarget'");
    expect(adminPanel).not.toContain('이미지 생성, 슬라이드 생성, AI 기반 콘텐츠 제작에 씁니다.');
    expect(adminPanel).not.toContain('비용/권한 영향 큼');
  });

  it('keeps formatting-only return values out of the copy inventory', () => {
    const scanner = fs.readFileSync(path.resolve(sourceRoot, '../../../scripts/frontend-copy-inventory.mjs'), 'utf8');
    expect(scanner).toContain('function isFormattingOnlyReturn(text)');
    expect(scanner).toContain("!isFormattingOnlyReturn(text)");
    expect(scanner).toContain("text.replaceAll('{{expression}}', '')");
    expect(scanner).toContain("/^(?:pi|local):$/i");
    expect(scanner).toContain("(?:tower:|(?:[a-z]+-)?(?:bg|text|border|tone|scale|shadow|ring|opacity)-)");
  });

  it('keeps English and Korean locale keys aligned and non-empty', () => {
    const enDirectory = path.join(sourceRoot, 'locales', 'en');
    const namespaces = fs.readdirSync(enDirectory).filter(file => file.endsWith('.json')).map(file => file.replace(/\.json$/, '')).sort();

    for (const namespace of namespaces) {
      const en = readLocale('en', namespace);
      const ko = readLocale('ko', namespace);
      expect([...flattenKeys(en)].sort(), `${namespace} locale keys`).toEqual([...flattenKeys(ko)].sort());
      for (const [language, locale] of [['en', en], ['ko', ko]] as const) {
        const emptyKeys: string[] = [];
        const visit = (value: unknown, prefix = '') => {
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            for (const [key, child] of Object.entries(value)) visit(child, prefix ? `${prefix}.${key}` : key);
          } else if (typeof value === 'string' && value.trim() === '') emptyKeys.push(prefix);
        };
        visit(locale);
        const knownExistingEmpty = language === 'ko' && namespace === 'admin' ? ['promptDefaultApplyBefore'] : [];
        expect(emptyKeys, `${language}/${namespace} empty locale values`).toEqual(knownExistingEmpty);
      }
    }
  });

  it('routes login validation and app authentication fallbacks through locale keys', () => {
    const login = fs.readFileSync(path.join(sourceRoot, 'components/auth/LoginPage.tsx'), 'utf8');
    const app = fs.readFileSync(path.join(sourceRoot, 'App.tsx'), 'utf8');

    for (const key of ['inviteCodeRequired', 'usernameRequired', 'passwordRequired', 'displayNameRequired']) {
      expect(login).toContain(`t('${key}')`);
    }
    expect(login).not.toContain('User ID를 입력해주세요');
    expect(app).toContain("t('auth:cannotConnect')");
    expect(app).toContain("t('auth:signupPendingApproval')");
    expect(app).toContain("t('auth:signupSubmitted')");
    expect(app).toContain("t('layout:showSidebar')");
    expect(app).not.toContain("setAuthError('Cannot connect to server')");
  });

  it('routes shared notification, resize, Viewer, and file-menu copy through layout locale keys', () => {
    const app = fs.readFileSync(path.join(sourceRoot, 'App.tsx'), 'utf8');
    const notifications = fs.readFileSync(path.join(sourceRoot, 'components/layout/NotificationBell.tsx'), 'utf8');
    const resizeHandles = fs.readFileSync(path.join(sourceRoot, 'components/layout/ResizeHandle.tsx'), 'utf8');

    for (const key of ['notifications', 'markAllNotificationsRead', 'noNotificationsYet', 'notificationJustNow']) {
      expect(notifications).toContain(`t('${key}')`);
    }
    expect(notifications).not.toContain('Mark all read');
    expect(resizeHandles).toContain("t('resizePanel')");
    expect(resizeHandles).toContain("t('resizeSidebar')");
    for (const key of ['resizeViewer', 'viewerDescription', 'goToFolder', 'openInNewBrowserTab', 'download', 'share', 'copyPath', 'closeTab']) {
      expect(app).toContain(`t('layout:${key}')`);
    }
    expect(app).not.toContain('aria-label="Viewer 너비 조절"');
  });

  it('routes ContextPanel loading, empty, and media states through layout locale keys', () => {
    const contextPanel = fs.readFileSync(path.join(sourceRoot, 'components/layout/ContextPanel.tsx'), 'utf8');
    for (const key of ['loadingEditor', 'loadingMarkdownEditor', 'loadingQuickEdit', 'loadingHtmlEditor']) {
      expect(contextPanel).toContain(`i18nKey="${key}"`);
    }
    for (const key of [
      'loadingViewer', 'loadingImage', 'imageLoadFailed', 'loadingSqliteViewer',
      'loadingCadViewer', 'noFileSelected', 'selectFileToView', 'pdfOpensInBrowser',
      'pdfBrowserExplanation', 'openInNewBrowserTab', 'downloadVideo',
    ]) {
      expect(contextPanel).toContain(`t('${key}')`);
    }
    expect(contextPanel).not.toContain('Loading viewer...');
    expect(contextPanel).not.toContain('Select a file to view it here');
    expect(contextPanel).not.toContain('Download video');
  });

  it('routes ContextPanel file-change comparison and conflict copy through layout locale keys', () => {
    const contextPanel = fs.readFileSync(path.join(sourceRoot, 'components/layout/ContextPanel.tsx'), 'utf8');
    for (const key of [
      'fileChanged', 'compareCurrentAndLatest', 'compareCurrentAndLatestDescription',
      'loadingLatestFile', 'noChangesToCompare', 'changeGroup', 'applyThisChange',
      'diffColorExplanation', 'keepMyEdits', 'replaceWithLatestFile',
      'fileReloadFailedWithStatus', 'fileReloadFailed', 'externalFileChangeDetected',
      'compareChanges', 'applyLatestVersion',
    ]) {
      expect(contextPanel).toContain(`t('${key}`);
    }
    expect(contextPanel).not.toContain('AI 또는 다른 작업이 이 파일을 새로 저장했습니다.');
    expect(contextPanel).not.toContain('현재 편집본과 최신 파일 비교</h2>');
  });

  it('routes ContextPanel personal-note and view-mode copy through layout locale keys', () => {
    const contextPanel = fs.readFileSync(path.join(sourceRoot, 'components/layout/ContextPanel.tsx'), 'utf8');
    for (const key of [
      'noteTitle', 'enterNoteTitle', 'personalNoteTitleAndFilename', 'noteTitleRenamesFile',
      'readDocument', 'readMode', 'editMarkdownDocument', 'editMode', 'editWithPreview',
      'splitMode', 'editSource', 'sourceMode', 'viewMode', 'quickEditBeta',
    ]) {
      expect(contextPanel).toContain(`t('${key}')`);
    }
    expect(contextPanel).not.toContain('placeholder="제목을 입력하세요"');
    expect(contextPanel).not.toContain('<option value="preview">읽기</option>');
  });

  it('routes the remaining ContextPanel navigation and file actions through locale keys', () => {
    const contextPanel = fs.readFileSync(path.join(sourceRoot, 'components/layout/ContextPanel.tsx'), 'utf8');
    for (const key of [
      'unsavedChangesTitle', 'unsavedChangesCloseMessage', 'openFileLink',
      'closeFileAndGoBack', 'closeFile', 'back', 'backShortcut', 'forwardShortcut',
      'createExternalShareLink', 'shareLink', 'viewSource', 'quickEditBeta',
      'reloadFile', 'refresh',
    ]) {
      expect(contextPanel).toContain(`t('${key}`);
    }
    expect(contextPanel).not.toContain('title="파일 다시 읽기"');
    expect(contextPanel).not.toContain('title={`Open: ${text}`}');
  });

  it('routes engine switching and session-file menu copy through layout locale keys', () => {
    const engineSwitch = fs.readFileSync(path.join(sourceRoot, 'components/layout/EngineSwitchConfirmModal.tsx'), 'utf8');
    const sessionFiles = fs.readFileSync(path.join(sourceRoot, 'components/layout/SessionFilesMenuSection.tsx'), 'utf8');

    for (const key of ['switchEngine', 'engineSwitchDescription', 'engineSwitchPreserves', 'engineSwitchDropsThinking', 'engineSwitchFirstResponseSlow', 'switchingEngine', 'switchEngineAction']) {
      expect(engineSwitch).toContain(key);
    }
    for (const key of ['thisSessionFiles', 'selectSessionForFiles', 'setWorkspaceForFiles', 'noEditedFilesYet', 'loadingFiles', 'sessionFilesDescription', 'recentProjectFiles', 'recentProjectFilesDescription', 'fileSourceTooltip', 'recent']) {
      expect(sessionFiles).toContain(`t('${key}`);
    }
    expect(engineSwitch).not.toContain('>엔진 전환</h2>');
    expect(sessionFiles).not.toContain('세션을 선택하면 파일이 표시됩니다.');
  });

  it('routes small layout navigation and App diagnostics through layout locale keys', () => {
    const app = fs.readFileSync(path.join(sourceRoot, 'App.tsx'), 'utf8');
    const mobileTabs = fs.readFileSync(path.join(sourceRoot, 'components/layout/MobileTabBar.tsx'), 'utf8');
    const modelSelector = fs.readFileSync(path.join(sourceRoot, 'components/layout/ModelSelector.tsx'), 'utf8');
    const spaceFilter = fs.readFileSync(path.join(sourceRoot, 'components/layout/SpaceFilter.tsx'), 'utf8');

    expect(mobileTabs).toMatch(/t\('(conversationsNav|workHubNav)'\)/);
    for (const key of ['conversationsNav', 'workHubNav', 'aiTeam', 'settings']) expect(mobileTabs).toContain(`t('${key}')`);
    for (const key of ['modelSelection', 'localLlm']) expect(modelSelector).toContain(`t('${key}')`);
    expect(spaceFilter).toContain("t('all')");
    for (const key of ['modelLabel', 'userMessageCount', 'enterPathHint', 'parentDirectory', 'noSubdirectories']) {
      expect(app).toContain(`t('${key}`);
    }
    expect(app).not.toContain('placeholder="Enter path and press Enter"');
    expect(modelSelector).not.toContain('>모델 선택</div>');
  });

  it('keeps Header identity translation collections stable across ordinary renders', () => {
    const header = fs.readFileSync(path.join(sourceRoot, 'components/layout/Header.tsx'), 'utf8');
    expect(header).toContain('const identityLines = React.useMemo(');
    expect(header).toContain('[i18n.resolvedLanguage, t]');
    expect(header).not.toContain("const identityLines = t('towerIdentityLines', { returnObjects: true })");
  });

  it('routes Header navigation, model groups, and copy-reference labels through layout locale keys', () => {
    const header = fs.readFileSync(path.join(sourceRoot, 'components/layout/Header.tsx'), 'utf8');
    for (const key of [
      'conversationsNav', 'workHubNav', 'ai', 'mySpace', 'myTodo', 'workHistory', 'pendingReplies',
      'favorites', 'sessionHistory', 'operations', 'automation',
      'beta', 'skillWorkbench', 'settingsAndManagement', 'personalCredentials',
      'externalAgentDeployment', 'modelSelection', 'localLlm', 'copied', 'copyReference',
    ]) {
      expect(header).toContain(`t('${key}`);
    }
    expect(header).not.toContain('label="개인 크레덴셜"');
    expect(header).not.toContain('>Local LLM</div>');
  });

  it('routes FileTabBar status, menus, and session information through layout locale keys', () => {
    const fileTabBar = fs.readFileSync(path.join(sourceRoot, 'components/layout/FileTabBar.tsx'), 'utf8');
    for (const key of [
      'awaitingReply', 'aiNeedsReply', 'sessionWorking', 'completed', 'completedUntilOpened',
      'closeChatTab', 'fileTabHint', 'closeTab', 'mainTabBar',
      'teammateHome', 'closeSystemTab', 'moreTabsLeft', 'moreTabsRight', 'viewInViewer',
      'refreshCurrentFile', 'sessionInfo', 'showInSidebar', 'enterNewSessionName',
      'rename', 'pinTab', 'unpinTab', 'doubleClick', 'goToFolder', 'download', 'share',
      'moveToMainTab', 'closeOtherTabs', 'closeAllTabs', 'notAvailableYet',
      'contextUsageValue', 'unnamedSession', 'workspace', 'recentContextUsage',
      'workspacePath', 'model', 'sessionLink', 'clickToCopyLink',
    ]) {
      expect(fileTabBar).toContain(`t('${key}`);
    }
    expect(fileTabBar).not.toContain('aria-label="본문 탭 바"');
    expect(fileTabBar).not.toContain('>세션 정보</div>');
  });

  it('routes Sidebar AI navigation, personal files, and sorting copy through layout locale keys', () => {
    const sidebar = fs.readFileSync(path.join(sourceRoot, 'components/layout/Sidebar.tsx'), 'utf8');
    for (const key of [
      'openAiTeamHomeWithCount', 'teamWorkspace', 'rolesToolsPermissionsTogether',
      'buildTeam', 'renameAi', 'aiTeamUsageSummary', 'openNamedHome', 'namedHome',
      'startNewConversationWith', 'openMyTodoInViewer',
      'myTodo', 'viewer', 'viewMyFiles', 'loadingMyFiles', 'retry',
      'noPersonalFilesHint', 'namedFileActions', 'fileActions', 'workspaceFiles',
      'renamePersonalFile', 'open', 'rename', 'copyPath', 'moveToArchive',
      'sort', 'workspaceSort', 'pinnedThenRecent',
      'recentActivity', 'nameAz', 'newestCreated', 'fileSort', 'foldersThenName',
      'recentlyModified', 'byType',
    ]) {
      expect(sidebar).toMatch(new RegExp(`t\\([\"']${key}`));
    }
    expect(sidebar).not.toContain('>작업 공간 파일</div>');
    expect(sidebar).not.toContain('title="정렬"');
  });

  it('routes session AI Panel sample prompts through locale collections', () => {
    const aiPanel = fs.readFileSync(path.join(sourceRoot, 'components/rooms/AiPanel.tsx'), 'utf8');
    expect(aiPanel).toContain("t(`aiPanelSamplePrompts.${promptGroup}`, { returnObjects: true })");
    for (const group of ['cad', 'automation', 'file']) {
      expect(aiPanel).toContain(`? '${group}'`);
    }
    expect(aiPanel).toContain(": 'session';");
    expect(aiPanel).not.toContain("'channel'");
    expect(aiPanel).not.toContain('share_to_channel');
    expect(aiPanel).not.toContain('이 도면을 견적 전에 검토해줘');
    expect(aiPanel).not.toContain('이 채널의 최근 논의를 요약해줘');
  });

  it('routes Chat empty-state prompts, first-task starters, and guide copy through locale collections', () => {
    const chatPanel = fs.readFileSync(path.join(sourceRoot, 'components/chat/ChatPanel.tsx'), 'utf8');
    expect(chatPanel).toContain("t('emptyState.prompts', { returnObjects: true })");
    expect(chatPanel).toContain("t('emptyState.agentStarters', { returnObjects: true })");
    for (const key of [
      'visualKnowledge', 'visualTools', 'visualFiles', 'firstTask', 'assignFirstTask',
      'firstTaskHint', 'headline', 'description', 'descriptionFollowup', 'helpPrefix',
      'helpMiddle', 'helpSuffix', 'startGuide', 'askInChat',
    ]) {
      expect(chatPanel).toContain(`t('emptyState.${key}`);
    }
    expect(chatPanel).not.toContain('EMPTY_STATE_PROMPTS');
    expect(chatPanel).not.toContain('실제 10년차 팀원에게 맡기듯 시켜보세요');
  });

  it('routes rotating Header identity and Chat turn status copy through locale collections', () => {
    const header = fs.readFileSync(path.join(sourceRoot, 'components/layout/Header.tsx'), 'utf8');
    const chatPanel = fs.readFileSync(path.join(sourceRoot, 'components/chat/ChatPanel.tsx'), 'utf8');
    expect(header).toContain("t('towerIdentityLines', { returnObjects: true })");
    expect(header).not.toContain('TOWER_IDENTITY_LINES');
    expect(header).not.toContain('최고 출력을 실험합니다');
    expect(chatPanel).toContain("t('activeTurnStatusLines', { returnObjects: true })");
    expect(chatPanel).toContain("turnPhase.${phaseKeys[phase] || 'working'}");
    expect(chatPanel).not.toContain('ACTIVE_TURN_STATUS_LINES');
    expect(chatPanel).not.toContain('생각이 예열되는 중입니다');
  });

  it('routes SecureInputBlock security, save, and credential fallback copy through chat locale keys', () => {
    const secureInput = fs.readFileSync(path.join(sourceRoot, 'components/chat/SecureInputBlock.tsx'), 'utf8');
    for (const key of [
      'invalidSecureInputJson', 'invalidJsonField', 'credentialVaultSaveFailed',
      'noProjectForCredentialGrant', 'credentialGrantFailed', 'secureInputSaveFailed',
      'secureInputSaved', 'secureInputNotInHistoryOrContext', 'secureInput',
      'serviceAccountJsonPlaceholder', 'secureInputNotStoredInChat', 'vaultMetadataOnly',
      'saving', 'saveToTarget',
    ]) {
      expect(secureInput).toContain(`t('${key}`);
    }
    expect(secureInput).not.toContain('값은 채팅 히스토리와 AI 컨텍스트에 저장되지 않습니다.');
    expect(secureInput).not.toContain('Save to {');
  });

  it('routes small chat blocks and cards through chat locale keys', () => {
    const files = [
      'FloatingQuestionCard.tsx', 'BrowserLiveBlock.tsx', 'SvgBlock.tsx',
      'AttachmentChip.tsx', 'BrowserPopupBlock.tsx', 'CadEvidenceBlock.tsx', 'FormBlock.tsx',
    ];
    const combined = files.map((file) => fs.readFileSync(path.join(sourceRoot, 'components/chat', file), 'utf8')).join('\n');
    for (const key of [
      'dismissQuestion', 'customAnswerAddedLabel', 'customAnswerAdded', 'other', 'add', 'skip', 'sendResponse',
      'remoteBrowser', 'loading', 'shrink', 'expand', 'openInNewTab', 'connectingRemoteBrowser',
      'svgError', 'copySvgSource', 'copy', 'open', 'remove', 'sessionOnlySevenDays', 'sessionOnly',
      'submitted', 'selectPlaceholder', 'submit', 'openBrowser', 'popupOpened', 'focus', 'done',
      'popupBlocked', 'retry', 'cadEvidence', 'linkedToDrawingPreview', 'evidenceNumber', 'viewInDrawing',
    ]) {
      expect(combined).toContain(`t('${key}`);
    }
    expect(combined).not.toContain('Popup blocked by browser');
    expect(combined).not.toContain('도면에서 보기');
  });

  it('routes FileViewerPage loading, preview, document, mode, and share controls through files locale keys', () => {
    const viewer = fs.readFileSync(path.join(sourceRoot, 'components/files/FileViewerPage.tsx'), 'utf8');
    for (const key of [
      'loadingEditor', 'loadingMarkdownEditor', 'loadingQuickEdit', 'loadingHtmlEditor',
      'pdfOpensInBrowserTab', 'pdfBrowserViewerHint', 'openInNewBrowserTab',
      'downloadVideo', 'noFilePath', 'refreshBlockedByUnsavedChanges',
      'refreshComplete', 'saved', 'saveFailed', 'reloadFile', 'refresh',
      'documentWidthAndZoom', 'zoomDocumentOut', 'resetZoomTo100',
      'zoomDocumentIn', 'documentWidth', 'readableWidth', 'wideWidth',
      'fullWidth', 'readAsDocument', 'read', 'editMarkdownDocument', 'edit',
      'previewWhileEditing', 'split', 'editSource', 'source', 'viewMode',
      'quickEditBeta', 'createExternalShareLink', 'shareLink', 'viewSource',
      'loadingCadViewer', 'loadingViewer', 'loadingSqliteViewer', 'save', 'modified',
    ]) {
      expect(viewer).toContain(`t('${key}`);
    }
    expect(viewer).not.toContain('PDF는 브라우저 탭에서 엽니다');
    expect(viewer).not.toContain('title="보기 모드"');
  });

  it('routes FileTree move, creation, favorites, and action labels through files locale keys', () => {
    const fileTree = fs.readFileSync(path.join(sourceRoot, 'components/files/FileTree.tsx'), 'utf8');
    for (const key of [
      'moveToFolder', 'confirmMoveItemToFolder', 'move', 'uploadFilesHere',
      'newFile', 'newFolder', 'newSessionHere', 'addToFavorites',
      'openInNewWindow', 'fileActions',
    ]) {
      expect(fileTree).toContain(`t('${key}`);
    }
    expect(fileTree).not.toContain("label: 'Upload files here'");
    expect(fileTree).not.toContain('aria-label="File actions"');
  });

  it('routes file sharing and inline-edit controls through files locale keys', () => {
    const files = [
      'components/files/ShareModal.tsx',
      'components/files/inline-edit/DiffPreview.tsx',
      'components/files/inline-edit/SelectionBar.tsx',
    ].map((relativePath) => fs.readFileSync(path.join(sourceRoot, relativePath), 'utf8')).join('\n');
    for (const key of [
      'shareFile', 'externalLink', 'internalLink', 'createAndCopyLink',
      'internalLinkAccessHint', 'orShareWithUser', 'selectUser', 'currentShares',
      'howShouldThisChange', 'applyEditEnter', 'undoLastAiEdit', 'aiEditPreview',
      'noChanges', 'aiFoundNoChangesInSelection', 'retryWithLargerSelection',
    ]) {
      expect(files).toContain(`t('${key}`);
    }
    expect(files).toContain('i18nKey="deleteSelectionHint"');
    for (const key of ['formal', 'concise', 'simplify', 'natural', 'factCheck', 'improveConsistency']) {
      expect(files).toContain(`labelKey: '${key}'`);
    }
    expect(files).not.toContain('>파일 공유</h2>');
    expect(files).not.toContain('placeholder="이 부분을 어떻게 고칠까요?"');
  });

  it('routes spreadsheet, SQLite, and HTML preview controls through files locale keys', () => {
    const files = [
      'components/files/XlsxPreview.tsx',
      'components/files/SqlitePreview.tsx',
      'components/files/HtmlPreviewSurface.tsx',
    ].map((relativePath) => fs.readFileSync(path.join(sourceRoot, relativePath), 'utf8')).join('\n');
    for (const key of [
      'loadingSpreadsheet', 'spreadsheetPreviewTruncated', 'emptySheet',
      'databaseHasNoUserTables', 'sqliteQueryFailed', 'loadingSqliteDatabase',
      'rows', 'showingFirstRows', 'columns', 'schema', 'emptyTable',
      'selectTableToView', 'zoomOut', 'zoomIn', 'fit',
    ]) {
      expect(files).toContain(`t('${key}`);
    }
    expect(files).not.toContain('Loading SQLite database...');
    expect(files).not.toContain('title="Zoom out"');
  });

  it('routes compact file actions, office previews, and tab management through files locale keys', () => {
    const files = [
      'components/files/FileActionsMenu.tsx',
      'components/files/OfficePreviewToolbar.tsx',
      'components/files/TabBar.tsx',
      'components/files/DocxPreview.tsx',
      'components/files/PptxPreview.tsx',
      'components/files/HwpPreview.tsx',
    ].map((relativePath) => fs.readFileSync(path.join(sourceRoot, relativePath), 'utf8')).join('\n');
    for (const key of [
      'moreFileActions', 'pdfPreview', 'openInBrowserPdfViewer', 'openPdfInNewTab',
      'downloadOriginalFile', 'downloadOriginal', 'convertingDocument',
      'documentPreviewFailed', 'convertingPresentation', 'presentationPreviewFailed',
      'convertingHwpDocument', 'hwpPreviewFailed', 'unsavedChanges',
      'confirmCloseUnsavedChanges', 'closeOtherTabs', 'closeAllTabs', 'manageTabs',
      'enterNumber', 'unsavedChangesClickToClose', 'closeTab',
    ]) {
      expect(files).toContain(`t('${key}`);
    }
    expect(files).not.toContain('Converting document...');
    expect(files).not.toContain('파일 작업 더보기');
  });

  it('routes the remaining Sidebar session, connection, member, and settings copy through locale keys', () => {
    const sidebar = [
      'components/layout/Sidebar.tsx',
      'features/navigation-sidebar/project-files/SidebarProjectFiles.tsx',
      'features/navigation-sidebar/sessions/SidebarSessionsToolbar.tsx',
    ].map((relativePath) => fs.readFileSync(path.join(sourceRoot, relativePath), 'utf8')).join('\n');
    for (const key of [
      'runningSessions', 'sessionType', 'chats', 'runs',
      'openAiConversations', 'openNamedActionsMenu', 'more', 'workspaceHasRunningSessions',
      'newChat', 'goToAgentHome', 'defaultConversationDisplay', 'showOnlyCount',
      'loadingConnections', 'noProjectConnections', 'githubActions', 'connectionWarnings',
      'youParenthetical', 'noMembers',
      'alsoSavedToAgentsMd', 'newChatsUseProjectFolder', 'moveToRoot',
      'confirmMoveItemToRoot', 'move', 'openNamedHome', 'newSessionInNamedDeck',
      'confirmArchivePersonalFile', 'membersCount',
    ]) {
      expect(sidebar).toMatch(new RegExp(`t\\([\"']${key}`));
    }
    expect(sidebar).not.toContain('Loading connections…');
    expect(sidebar).not.toContain('Secrets hidden');
    expect(sidebar).not.toContain('에이전트 홈으로 가기');
  });
});
