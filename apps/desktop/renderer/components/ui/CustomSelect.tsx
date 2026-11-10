import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, Check } from 'lucide-react';

export interface CustomSelectOption {
  value: string;
  label: string;
}

export interface CustomSelectProps {
  value: string;
  options: CustomSelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  style?: React.CSSProperties;
  buttonStyle?: React.CSSProperties;
  menuStyle?: React.CSSProperties;
  minWidth?: string;
  width?: string;
  className?: string;
  title?: string;
  ariaLabel?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
  variant?: 'default' | 'pill';
  align?: 'left' | 'right';
  maxMenuWidth?: string;
  optionStyle?: React.CSSProperties;
}

export const CustomSelect: React.FC<CustomSelectProps> = ({
  value,
  options,
  onChange,
  placeholder = 'Tanlang...',
  style,
  buttonStyle,
  menuStyle,
  minWidth = '130px',
  width,
  className,
  title,
  ariaLabel,
  disabled = false,
  size = 'md',
  variant = 'default',
  align = 'left',
  maxMenuWidth,
  optionStyle
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find((o) => o.value === value);
  const displayLabel = selectedOption ? selectedOption.label : placeholder;

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const height = size === 'sm' ? '32px' : '35px';
  const borderRadius = variant === 'pill' ? '9999px' : '8px';

  return (
    <div
      ref={containerRef}
      className={`custom-select-container ${className || ''}`}
      style={{
        position: 'relative',
        display: 'inline-block',
        minWidth: width ? undefined : minWidth,
        width: width || undefined,
        userSelect: 'none',
        ...style
      }}
    >
      <select
        aria-label={ariaLabel || title}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        tabIndex={-1}
        style={{
          position: 'absolute',
          width: '1px',
          height: '1px',
          padding: 0,
          margin: '-1px',
          overflow: 'hidden',
          clip: 'rect(0, 0, 0, 0)',
          whiteSpace: 'nowrap',
          border: 0,
          opacity: 0,
          pointerEvents: 'none'
        }}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        title={title}
        disabled={disabled}
        onClick={() => !disabled && setIsOpen(!isOpen)}
        style={{
          width: '100%',
          height,
          padding: '0 10px 0 12px',
          backgroundColor: 'var(--bg-surface, #ffffff)',
          border: isOpen ? '1px solid var(--primary, #059669)' : '1px solid var(--border-subtle, #e2e8f0)',
          borderRadius,
          fontSize: '15px',
          fontWeight: 600,
          color: 'var(--text-primary, #0f172a)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '6px',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.6 : 1,
          boxShadow: isOpen ? '0 0 0 3px rgba(16, 185, 129, 0.15)' : 'none',
          transition: 'all 0.15s ease',
          outline: 'none',
          ...buttonStyle
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {displayLabel}
        </span>
        <ChevronDown
          size={14}
          style={{
            color: 'var(--text-muted, #64748b)',
            flexShrink: 0,
            transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.15s ease'
          }}
        />
      </button>

      {isOpen && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: align === 'right' ? 'auto' : 0,
            right: align === 'right' ? 0 : 'auto',
            minWidth: '100%',
            width: 'max-content',
            maxWidth: maxMenuWidth || '420px',
            zIndex: 1300,
            backgroundColor: 'var(--bg-surface, #ffffff)',
            border: '1px solid var(--border-subtle, #e2e8f0)',
            borderRadius: '10px',
            boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.12), 0 8px 10px -6px rgba(0, 0, 0, 0.08)',
            maxHeight: '260px',
            overflowY: 'auto',
            padding: '4px',
            ...menuStyle
          }}
        >
          {options.map((opt) => {
            const isSelected = opt.value === value;
            return (
              <div
                key={opt.value}
                onClick={() => {
                  onChange(opt.value);
                  setIsOpen(false);
                }}
                style={{
                  padding: size === 'sm' ? '7px 12px' : '8px 14px',
                  borderRadius: '6px',
                  fontSize: buttonStyle?.fontSize || (size === 'sm' ? '15px' : '17px'),
                  fontWeight: isSelected ? 700 : 500,
                  color: isSelected ? 'var(--primary, #059669)' : 'var(--text-primary, #0f172a)',
                  backgroundColor: isSelected ? 'var(--primary-light, #ecfdf5)' : 'transparent',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '8px',
                  cursor: 'pointer',
                  transition: 'background-color 0.1s ease',
                  marginBottom: '2px',
                  ...optionStyle
                }}
                onMouseEnter={(e) => {
                  if (!isSelected) e.currentTarget.style.backgroundColor = 'var(--bg-surface-subtle, #f8fafc)';
                }}
                onMouseLeave={(e) => {
                  if (!isSelected) e.currentTarget.style.backgroundColor = 'transparent';
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {opt.label}
                </span>
                {isSelected && <Check size={14} style={{ color: 'var(--primary, #059669)', flexShrink: 0 }} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
