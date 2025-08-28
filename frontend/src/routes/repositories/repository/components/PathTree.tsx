import React from 'react';
import {
  ChevronRight,
  ChevronDown,
  File,
  Folder,
  FileCode,
} from 'lucide-react';
import type { DirectoryNode } from '../../../../utils/pathTree';

interface PathTreeProps {
  tree: DirectoryNode;
  selectedPath?: string;
  expandedPaths: Set<string>;
  onSelect: (path: string) => void;
  onToggleExpand: (path: string) => void;
  level?: number;
}

interface TreeNodeProps {
  node: DirectoryNode;
  selectedPath?: string;
  expandedPaths: Set<string>;
  onSelect: (path: string) => void;
  onToggleExpand: (path: string) => void;
  level: number;
}

function TreeNode({
  node,
  selectedPath,
  expandedPaths,
  onSelect,
  onToggleExpand,
  level,
}: TreeNodeProps) {
  const isDirectory = node.type === 'directory';
  const isExpanded = expandedPaths.has(node.path);
  const isSelected = selectedPath === node.path;
  const hasChildren = Object.keys(node.children).length > 0;

  const handleClick = () => {
    if (isDirectory && hasChildren) {
      onToggleExpand(node.path);
    } else {
      onSelect(node.path);
    }
  };

  const handleToggleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleExpand(node.path);
  };

  const getIcon = () => {
    if (isDirectory) {
      return <Folder size={16} className="text-blue-400" />;
    }

    if (node.type === 'source') {
      return <FileCode size={16} className="text-green-400" />;
    }

    return <File size={16} className="text-orange-400" />;
  };

  const getFileExtensionClass = () => {
    if (node.type === 'source') return 'text-green-400';
    if (node.type === 'artifact') return 'text-orange-400';
    return 'text-gray-400';
  };

  return (
    <div className="tree-node">
      <div
        className={`tree-node-content flex items-center gap-2 px-2 py-1 cursor-pointer hover:bg-white/5 rounded ${
          isSelected ? 'bg-white/10' : ''
        }`}
        style={{ paddingLeft: `${level * 16 + 8}px` }}
        onClick={handleClick}
      >
        {/* Expand/collapse button for directories with children */}
        {isDirectory && hasChildren ? (
          <button
            onClick={handleToggleClick}
            className="flex items-center justify-center w-4 h-4 hover:bg-white/10 rounded"
          >
            {isExpanded ? (
              <ChevronDown size={14} />
            ) : (
              <ChevronRight size={14} />
            )}
          </button>
        ) : (
          <div className="w-4" />
        )}

        {/* File/folder icon */}
        {getIcon()}

        {/* File/folder name */}
        <span className={`text-sm ${getFileExtensionClass()}`}>
          {node.name}
        </span>

        {/* Show artifact count for files with multiple artifacts */}
        {node.artifacts && node.artifacts.length > 1 && (
          <span className="text-xs text-gray-400 ml-auto">
            ({node.artifacts.length})
          </span>
        )}
      </div>

      {/* Render children if expanded */}
      {isDirectory && isExpanded && hasChildren && (
        <div className="tree-children">
          {Object.values(node.children)
            .sort((a, b) => {
              // Sort directories first, then files
              if (a.type === 'directory' && b.type !== 'directory') return -1;
              if (a.type !== 'directory' && b.type === 'directory') return 1;
              return a.name.localeCompare(b.name);
            })
            .map((child) => (
              <TreeNode
                key={child.path}
                node={child}
                selectedPath={selectedPath}
                expandedPaths={expandedPaths}
                onSelect={onSelect}
                onToggleExpand={onToggleExpand}
                level={level + 1}
              />
            ))}
        </div>
      )}
    </div>
  );
}

export default function PathTree({
  tree,
  selectedPath,
  expandedPaths,
  onSelect,
  onToggleExpand,
  level = 0,
}: PathTreeProps) {
  // If tree is empty, show empty state
  if (!tree || Object.keys(tree.children).length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-sm text-gray-400">
        No artifacts found
      </div>
    );
  }

  return (
    <div className="path-tree text-[var(--text)]">
      {Object.values(tree.children)
        .sort((a, b) => {
          // Sort directories first, then files
          if (a.type === 'directory' && b.type !== 'directory') return -1;
          if (a.type !== 'directory' && b.type === 'directory') return 1;
          return a.name.localeCompare(b.name);
        })
        .map((child) => (
          <TreeNode
            key={child.path}
            node={child}
            selectedPath={selectedPath}
            expandedPaths={expandedPaths}
            onSelect={onSelect}
            onToggleExpand={onToggleExpand}
            level={level}
          />
        ))}
    </div>
  );
}
