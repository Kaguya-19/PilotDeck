import { useTranslation } from 'react-i18next';
import { useAuth } from '../../components/auth';
import type { FrontendModule, SurfaceProps } from '../contracts';
import { ProfileTextSetting } from './shared';
import SharedKnowledgePage, { KnowledgeAddPage as SharedKnowledgeAddPage } from './staffdeck/vendor/KnowledgePage';
import { PilotDeckKnowledgePageProvider } from './staffdeck/vendor/knowledge-host-adapter';
import StaffDeckLocaleBoundary from './staffdeck/StaffDeckLocaleBoundary';
import { StaffDeckHostBinding } from './staffdeck-host-binding';

const BUILD_MARKER = 'staffdeck.knowledge.ui/v1';

function KnowledgePage() {
  const { user } = useAuth();
  const currentUser = user ? { id: String(user.id ?? ''), username: user.username, is_admin: user.is_admin === true } : undefined;
  return <StaffDeckHostBinding><StaffDeckLocaleBoundary><PilotDeckKnowledgePageProvider><SharedKnowledgePage currentUser={currentUser} /></PilotDeckKnowledgePageProvider></StaffDeckLocaleBoundary></StaffDeckHostBinding>;
}
function KnowledgeAddPage() {
  const { user } = useAuth();
  const currentUser = user ? { id: String(user.id ?? ''), username: user.username, is_admin: user.is_admin === true } : undefined;
  return <StaffDeckHostBinding><StaffDeckLocaleBoundary><PilotDeckKnowledgePageProvider><SharedKnowledgeAddPage currentUser={currentUser} /></PilotDeckKnowledgePageProvider></StaffDeckLocaleBoundary></StaffDeckHostBinding>;
}

function KnowledgeArtifactRenderer(props: SurfaceProps) {
  const { t } = useTranslation('staffdeck');
  const artifact = props.artifact as { name?: string; path?: string } | undefined;
  return <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">{t('knowledge.knowledgeArtifact', { name: artifact?.name ?? artifact?.path ?? t('knowledge.defaultCitation') })}</div>;
}

const module: FrontendModule = {
  id: 'staffdeck.knowledge', slot: 'knowledge', contract: 'staffdeck.knowledge/v1', source: 'staffdeck', frontendApiVersion: 'frontend-module/v1',
  buildMarker: BUILD_MARKER,
  requiresCapabilities: ['query'],
  pages: [
    { id: 'knowledge', path: '/knowledge', label: 'Knowledge', labelKey: 'staffdeck:nav.knowledge', component: KnowledgePage },
    { id: 'knowledge-new', path: '/knowledge/new', label: 'New knowledge base', labelKey: 'staffdeck:nav.knowledge', component: KnowledgeAddPage },
  ],
  settings: [{ id: 'knowledge-default-base', settingsSection: 'knowledge', label: 'Knowledge', labelKey: 'staffdeck:nav.knowledge', component: () => <KnowledgeProfileSetting /> }],
  artifactRenderers: [{ id: 'staffdeck.knowledge-citation-artifact', label: 'Knowledge citation artifact', artifactMimeTypes: ['application/x-staffdeck-citation'], component: KnowledgeArtifactRenderer }],
};
export default module;

function KnowledgeProfileSetting() {
  const { t } = useTranslation('staffdeck');
  return <ProfileTextSetting slot="knowledge" field="defaultBaseId" label={t('settings.defaultKnowledgeBase')} description={t('settings.defaultKnowledgeBaseDescription')} />;
}
