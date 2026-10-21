import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../../packages/frontend/src/i18n';
import '../../../packages/frontend/src/index.css';
import { AiSettingsManagement } from '../../../packages/frontend/src/components/admin/model-management/ModelManagement';
createRoot(document.getElementById('root')!).render(<AiSettingsManagement token="fixture" canEditReasoning />);
