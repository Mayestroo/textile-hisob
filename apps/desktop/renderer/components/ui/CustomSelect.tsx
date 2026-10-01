import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, Check } from 'lucide-react';

export interface CustomSelectOption {
  value: string;
  label: string;
}

interface CustomSelectProps {
  value: string;
  options: CustomSelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  style?: React.CSSProperties;
  minWidth?: string;
}

export const CustomSelect: React.FC<CustomSelectProps> = ({
  value,
  options,
  onChange,
  placeholder = 'Tanlang...',
  style,
  minWidth = '140px'
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find((o) => o.value === value);
  const displayLabel = selectedOption ? selectedOption.label : placeholder;

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div 
      ref={containerRef} 
      style={{ 
        position: 'relative', 
        display: 'inline-block', 
        minWidth, 
        userSelect: 'none',
        ...style 
      }}
    >
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        style={{
          width: '100%',
          height: '32px',
          padding: '0 12px 0 14px',
          backgroundColor: 'var(--bg-surface)',
          border: isOpen ? '1px solid var(--primary)' : '1px solid var(--border-default)',
          borderRadius: 'var(--radius-full)',
          fontSize: '12.5px',
          fontWeight: 600,
          color: 'var(--text-primary)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          cursor: 'pointer',
          boxShadow: isOpen ? '0 0 0 3px var(--primary-glow)' : 'none',
          transition: 'all 0.15s ease',
          outline: 'none'
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {displayLabel}
        </span>
        <ChevronDown 
          size={14} 
          color="var(--text-muted)" 
          style={{ 
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
            left: 0,
            right: 0,
            zIndex: 1000,
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-lg)',
            maxHeight: '220px',
            overflowY: 'auto',
            padding: '4px'
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
                  padding: '7px 12px',
                  borderRadius: 'var(--radius-xs)',
                  fontSize: '12.5px',
                  fontWeight: isSelected ? 700 : 500,
                  color: isSelected ? 'var(--primary)' : 'var(--text-primary)',
                  backgroundColor: isSelected ? 'var(--primary-light)' : 'transparent',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  cursor: 'pointer',
                  transition: 'background-color 0.1s ease',
                  marginBottom: '2px'
                }}
                onMouseEnter={(e) => {
                  if (!isSelected) e.currentTarget.style.backgroundColor = 'var(--bg-surface-subtle)';
                }}
                onMouseLeave={(e) => {
                  if (!isSelected) e.currentTarget.style.backgroundColor = 'transparent';
                }}
              >
                <span>{opt.label}</span>
                {isSelected && <Check size={14} color="var(--primary)" />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
