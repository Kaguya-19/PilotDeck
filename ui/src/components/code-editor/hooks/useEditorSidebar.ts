import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { Project } from '../../../types/app';
import type { CodeEditorDiffInfo, CodeEditorFile } from '../types/types';

type UseEditorSidebarOptions = {
  selectedProject: Project | null;
  isMobile: boolean;
  initialWidth?: number;
};

const buildEditorFile = (
  filePath: string,
  projectName: string | undefined,
  diffInfo: CodeEditorDiffInfo | null = null,
): CodeEditorFile => {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const fileName = normalizedPath.split('/').pop() || filePath;
  return {
    name: fileName,
    path: normalizedPath,
    projectName,
    diffInfo,
  };
};

export const useEditorSidebar = ({
  selectedProject,
  isMobile,
  initialWidth = 600,
}: UseEditorSidebarOptions) => {
  const [fileStack, setFileStack] = useState<CodeEditorFile[]>([]);
  const [editorWidth, setEditorWidth] = useState(initialWidth);
  const [editorExpanded, setEditorExpanded] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [hasManualWidth, setHasManualWidth] = useState(false);
  const resizeHandleRef = useRef<HTMLDivElement | null>(null);

  const editingFile = fileStack.at(-1) ?? null;
  const canGoBack = fileStack.length > 1;
  const parentFile = canGoBack ? fileStack.at(-2) ?? null : null;

  const handleFileOpen = useCallback(
    (filePath: string, diffInfo: CodeEditorDiffInfo | null = null) => {
      setFileStack([buildEditorFile(filePath, selectedProject?.name, diffInfo)]);
    },
    [selectedProject?.name],
  );

  // Push onto the stack when following a markdown cross-reference inside preview.
  const handlePreviewFileOpen = useCallback(
    (filePath: string) => {
      const nextFile = buildEditorFile(filePath, selectedProject?.name);
      setFileStack((previous) => {
        const current = previous.at(-1);
        if (current?.path === nextFile.path) return previous;
        return [...previous, nextFile];
      });
    },
    [selectedProject?.name],
  );

  const handleFileGoBack = useCallback(() => {
    setFileStack((previous) => (previous.length > 1 ? previous.slice(0, -1) : previous));
  }, []);

  const handleCloseEditor = useCallback(() => {
    setFileStack([]);
    setEditorExpanded(false);
  }, []);

  // Close any open file tab when the user switches to a different project so
  // we don't carry a Project A file across into Project B's view. Switching
  // sessions within the same project keeps the editor open because
  // `selectedProject?.name` stays the same.
  useEffect(() => {
    setFileStack([]);
    setEditorExpanded(false);
  }, [selectedProject?.name]);

  const handleToggleEditorExpand = useCallback(() => {
    setEditorExpanded((previous) => !previous);
  }, []);

  const handleResizeStart = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (isMobile) {
        return;
      }

      // After first drag interaction, the editor width is user-controlled.
      setHasManualWidth(true);
      setIsResizing(true);
      event.preventDefault();
    },
    [isMobile],
  );

  useEffect(() => {
    const handleMouseMove = (event: globalThis.MouseEvent) => {
      if (!isResizing) {
        return;
      }

      // Get the main container (parent of EditorSidebar's parent) that contains both left content and editor
      const editorContainer = resizeHandleRef.current?.parentElement;
      const mainContainer = editorContainer?.parentElement;
      if (!mainContainer) {
        return;
      }

      const containerRect = mainContainer.getBoundingClientRect();
      // Calculate new editor width: distance from mouse to right edge of main container
      const newWidth = containerRect.right - event.clientX;

      const minWidth = 300;
      const maxWidth = containerRect.width * 0.8;

      if (newWidth >= minWidth && newWidth <= maxWidth) {
        setEditorWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing]);

  return {
    editingFile,
    canGoBack,
    parentFile,
    editorWidth,
    editorExpanded,
    hasManualWidth,
    resizeHandleRef,
    handleFileOpen,
    handlePreviewFileOpen,
    handleFileGoBack,
    handleCloseEditor,
    handleToggleEditorExpand,
    handleResizeStart,
  };
};
