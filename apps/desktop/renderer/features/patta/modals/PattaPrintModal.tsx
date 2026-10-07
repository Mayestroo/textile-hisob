import React from 'react';
import { Printer, X, FileText } from 'lucide-react';
import { ModelConfig } from '../../../types/workbook';
import { useWorkbookStore } from '../../../store/workbookStore';
import { findAvailablePattaStart } from '../../../store/pattaBatch';
import { buildPartyWorkSummary, buildPattaWorkTickets, calculateBatchWorkQuantities } from '../../../domain/pattaQuantity';
import { formatDateOnly } from '../../../utils/formatters';

export interface PrintBatchItem {
  model: ModelConfig;
  partyNumber: string;
  sizes: Record<string, string>;
  ishSoniPerPatta?: string;
  color?: string;
}

interface PattaPrintModalProps {
  items: PrintBatchItem[];
  onPrinted?: (printedItems: Array<{
    modelId: string;
    partyNumber: string;
    pattaCount: number;
    ishSoniPerPatta?: number;
    totalIshSoni?: number;
    ishSoni: number;
    sizes?: Record<string, string>;
    color: string;
  }>) => void;
  onClose: () => void;
}

interface PrintableTicket {
  ticketIndex: number;
  pattaNumber: number;
  party: string;
  size: string;
  modelTitle: string;
  date: string;
  color: string;
  ishSoni: string;
  operations: Array<{ name: string }>;
  pachkaCount: number;
  sizesSummary: string[];
}

export const PattaPrintModal: React.FC<PattaPrintModalProps> = ({
  items,
  onPrinted,
  onClose
}) => {
  const nextPattaNumber = useWorkbookStore((s) => s.nextPattaNumber);
  const printedPartyHistory = useWorkbookStore((s) => s.printedPartyHistory);
  const reusablePattaRanges = useWorkbookStore((s) => s.reusablePattaRanges);
  const confirmAction = useWorkbookStore((s) => s.confirmAction);
  const addNotification = useWorkbookStore((s) => s.addNotification);

  const printableItems = React.useMemo(() => items.map((item) => {
    const workTickets = buildPattaWorkTickets(Number(item.ishSoniPerPatta), item.sizes);
    const sizeCounts = new Map<string, number>();
    for (const ticket of workTickets) {
      sizeCounts.set(ticket.size, (sizeCounts.get(ticket.size) || 0) + 1);
    }
    const sizeEntries = Array.from(sizeCounts.entries());

    return {
      item,
      workTickets,
      sizeEntries,
      sizesSummary: sizeEntries.map(([size, count]) => `${size} - ${count} ta`)
    };
  }), [items]);

  // Generate flat list of tickets across all items in batch
  const tickets: PrintableTicket[] = React.useMemo(() => {
    const list: PrintableTicket[] = [];
    const today = formatDateOnly(new Date());

    // Reuse ranges released by archived parties before advancing the company counter.
    const allocationHistory = [...(printedPartyHistory || [])];
    let currentPattaNum = Math.max(1, Number(nextPattaNumber) || 1);

    for (const { item, workTickets, sizesSummary } of printableItems) {
      const existingParty = allocationHistory.find((party) => !party.isClosed && party.isArchived !== true
        && party.modelId === item.model.id && String(party.partyNumber).trim() === String(item.partyNumber).trim());
      const pattaStart = existingParty?.pattaStartNumber
        ?? findAvailablePattaStart(allocationHistory, Math.max(1, workTickets.length), currentPattaNum, reusablePattaRanges);
      if (!existingParty && workTickets.length > 0) {
        const pattaEnd = pattaStart + workTickets.length - 1;
        allocationHistory.push({
          id: `preview-${item.model.id}-${item.partyNumber}-${list.length}`,
          partyNumber: String(item.partyNumber),
          modelId: item.model.id,
          modelName: item.model.title || item.model.name,
          color: item.color || item.model.color || '',
          pattaCount: workTickets.length,
          cumulativePattaCount: pattaEnd,
          pattaStartNumber: pattaStart,
          pattaEndNumber: pattaEnd,
          ishSoni: 0,
          cumulativeIshSoni: 0,
          printedAt: ''
        });
        if (pattaStart >= currentPattaNum) currentPattaNum = pattaEnd + 1;
      }

      const opsList = item.model.pattaOpsOrder.map((opName) => ({
        name: opName
      }));

      // Clean model title (prevent duplicate "Модел- Модел-")
      const rawTitle = item.model.title || item.model.name;
      const cleanTitle = rawTitle.replace(/^(Модел-\s*|Модель-\s*|Model-\s*)+/i, '').trim();

      // Clean color value
      const finalColor = item.color !== undefined && item.color.trim() !== '' ? item.color : (item.model.color || 'Кора');
      const cleanColor = finalColor.replace(/^(Ранг\s*)+/i, '').trim();

      const pachkaCount = workTickets.length;
      for (let index = 0; index < workTickets.length; index += 1) {
        const workTicket = workTickets[index];
        list.push({
          ticketIndex: list.length + 1,
          pattaNumber: pattaStart + index,
          party: item.partyNumber || '1',
          size: workTicket.size,
          modelTitle: cleanTitle,
          date: today,
          color: cleanColor,
          ishSoni: String(workTicket.perPatta),
          operations: opsList,
          pachkaCount,
          sizesSummary
        });
      }
    }
    return list;
  }, [printableItems, nextPattaNumber, printedPartyHistory, reusablePattaRanges]);

  // Group tickets into pairs (2 tickets per A4 page in Portrait / Kitob format)
  const a4Pages: PrintableTicket[][] = React.useMemo(() => {
    const pages: PrintableTicket[][] = [];
    for (let i = 0; i < tickets.length; i += 2) {
      pages.push(tickets.slice(i, i + 2));
    }
    return pages;
  }, [tickets]);

  const [isPrinting, setIsPrinting] = React.useState(false);

  const generateFullHtml = () => {
    const printArea = document.getElementById('printable-patta-area');
    const contentHtml = printArea ? printArea.innerHTML : '';
    const safeTitle = (modelNamesText || '').replace(/[<>&"']/g, '');
    return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Patta - ${safeTitle}</title>
          <style>
            @page {
              size: A4 portrait;
              margin: 4mm 5mm;
            }
            * {
              box-sizing: border-box;
              margin: 0;
              padding: 0;
            }
            html, body {
              background: #ffffff;
              font-family: 'Times New Roman', Times, serif;
              font-weight: bold;
              color: #000000;
            }
            .print-page-a4 {
              width: 100% !important;
              height: 286mm !important;
              max-height: 286mm !important;
              box-sizing: border-box !important;
              display: flex !important;
              flex-direction: column !important;
              justify-content: space-between !important;
              padding: 0 !important;
              margin: 0 !important;
              page-break-inside: avoid !important;
              break-inside: avoid !important;
            }
            .print-page-a4:not(:last-child) {
              page-break-after: always !important;
              break-after: page !important;
            }
            .print-page-a4:last-child {
              page-break-after: avoid !important;
              break-after: avoid !important;
            }
            .print-ticket-box {
              width: 100% !important;
              height: 141mm !important;
              max-height: 141mm !important;
              box-sizing: border-box !important;
              display: flex !important;
              flex-direction: column !important;
              overflow: hidden !important;
              page-break-inside: avoid !important;
              break-inside: avoid !important;
              margin-bottom: 2mm !important;
            }
            .print-ticket-box:last-child {
              margin-bottom: 0 !important;
            }
            table {
              width: 100% !important;
              height: 100% !important;
              border-collapse: collapse !important;
              font-family: 'Times New Roman', Times, serif !important;
              font-weight: bold !important;
              color: #000000 !important;
              table-layout: fixed !important;
            }
            td, th {
              border: 1px solid #000000 !important;
              vertical-align: middle !important;
            }
            .vertical-patta-num {
              writing-mode: vertical-lr !important;
              text-orientation: sideways !important;
              -webkit-text-orientation: sideways !important;
              text-align: center !important;
              vertical-align: middle !important;
              font-weight: bold !important;
              white-space: nowrap !important;
            }
            .no-print {
              display: none !important;
            }
          </style>
        </head>
        <body>
          ${contentHtml}
        </body>
      </html>
    `;
  };

  // Isolated, clean, exact-page printing with native Cancel detection
  const handlePrint = async () => {
    if (isPrinting || tickets.length === 0) return;
    setIsPrinting(true);

    const printedSummary = printableItems
      .map(({ item, workTickets, sizeEntries }) => {
        const pattaCount = workTickets.length;
        return {
          modelId: item.model.id,
          partyNumber: item.partyNumber,
          pattaCount,
          ...buildPartyWorkSummary(calculateBatchWorkQuantities(Number(item.ishSoniPerPatta), pattaCount).totalIshSoni, pattaCount),
          sizes: Object.fromEntries(sizeEntries.map(([size, count]) => [size, String(count)])),
          color: item.color || item.model.color || 'Кора'
        };
      })
      .filter((p) => p.pattaCount > 0);

    const fullHtml = generateFullHtml();
    const eAPI = (window as any).electronAPI;

    try {
      if (eAPI?.printHtml) {
        const res = await eAPI.printHtml({
          html: fullHtml,
          title: `Patta - ${modelNamesText}`
        });

        if (res && res.success) {
          if (onPrinted) {
            onPrinted(printedSummary);
          }
          addNotification('success', 'Chop etildi', `${tickets.length} ta patta muvaffaqiyatli chop etildi.`);
          onClose();
        } else {
          // User clicked Cancel in Windows print dialog
          addNotification('info', 'Bekor qilindi', 'Chop etish bekor qilindi, partiyalar hisobga olinmadi.');
        }
      } else {
        // Isolated hidden iframe fallback for plain browser
        let printFrame = document.getElementById('patta-print-frame') as HTMLIFrameElement;
        if (!printFrame) {
          printFrame = document.createElement('iframe');
          printFrame.id = 'patta-print-frame';
          printFrame.style.position = 'fixed';
          printFrame.style.top = '-9999px';
          printFrame.style.left = '-9999px';
          printFrame.style.width = '0px';
          printFrame.style.height = '0px';
          printFrame.style.border = 'none';
          document.body.appendChild(printFrame);
        }

        const frameDoc = printFrame.contentDocument || printFrame.contentWindow?.document;
        if (!frameDoc) {
          window.print();
          return;
        }

        frameDoc.open();
        frameDoc.write(fullHtml);
        frameDoc.close();

        setTimeout(() => {
          printFrame.contentWindow?.focus();
          printFrame.contentWindow?.print();

          // In browser, confirm before recording to history
          setTimeout(async () => {
            const confirmed = await confirmAction({
              title: "Chop etish holati",
              message: `${tickets.length} ta patta printerdan muvaffaqiyatli chiqarildimi?\n(Agar bekor qilgan bo'lsangiz "Bekor qilish" ni bosing)`,
              confirmText: "Ha, chop etildi",
              cancelText: "Bekor qilish",
              isDanger: false
            });
            if (confirmed) {
              if (onPrinted) {
                onPrinted(printedSummary);
              }
              addNotification('success', 'Chop etildi', `${tickets.length} ta patta muvaffaqiyatli chop etildi.`);
              onClose();
            } else {
              addNotification('info', 'Bekor qilindi', 'Chop etish bekor qilindi, partiyalar hisobga olinmadi.');
            }
          }, 500);
        }, 300);
      }
    } catch (err: any) {
      console.error('Print error:', err);
      addNotification('error', 'Chop etishda xatolik', err?.message || 'Xatolik yuz berdi');
    } finally {
      setIsPrinting(false);
    }
  };

  const borderStyle = '1px solid #000000';
  const modelNamesText = items.map((i) => i.model.name).join(', ');

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 99999,
        backgroundColor: 'rgba(0, 0, 0, 0.85)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden'
      }}
    >
      {/* 1. Fixed Top Header */}
      <div
        className="no-print"
        style={{
          height: '64px',
          background: 'var(--bg-surface)',
          borderBottom: '1px solid var(--border-subtle)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 24px',
          flexShrink: 0,
          boxShadow: 'var(--shadow-md)'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            background: 'var(--primary-light)',
            color: 'var(--primary)',
            padding: '8px',
            borderRadius: 'var(--radius-md)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}>
            <FileText size={22} />
          </div>
          <div>
            <h3 style={{ margin: 0, fontSize: '16px', color: 'var(--text-primary)', fontWeight: 800 }}>
              Pechat ko'rinishi
            </h3>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
              Modellar: <strong>{modelNamesText}</strong> | Jami: <strong>{tickets.length} ta patta</strong> ({Math.ceil(tickets.length / 2)} ta A4 varaq)
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button
            onClick={handlePrint}
            disabled={isPrinting || tickets.length === 0}
            className="soft-btn soft-btn-primary"
            style={{
              padding: '8px 22px',
              fontSize: '13.5px',
              borderRadius: 'var(--radius-full)',
              opacity: isPrinting ? 0.7 : 1,
              cursor: isPrinting ? 'wait' : 'pointer'
            }}
          >
            <Printer size={16} />
            <span>{isPrinting ? "Yuborilmoqda..." : `Pechat qilish (${tickets.length} ta patta)`}</span>
          </button>

          <button
            onClick={onClose}
            className="soft-btn soft-btn-secondary"
            style={{
              padding: '8px 16px',
              borderRadius: 'var(--radius-full)'
            }}
          >
            <X size={16} />
            <span>Yopish</span>
          </button>
        </div>
      </div>

      {/* 2. Scrollable Body */}
      <div
        id="patta-print-scroll-container"
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '24px 16px 40px 16px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center'
        }}
      >
        <div id="printable-patta-area" style={{ width: '100%', maxWidth: '820px' }}>
          {tickets.length === 0 ? (
            <div style={{ background: '#ffffff', padding: '40px', textAlign: 'center', borderRadius: '8px' }}>
              <p style={{ fontSize: '15px', color: '#605e5c', margin: 0 }}>
                Pechat qilish uchun kamida bitta razmer sonini kiriting (masalan, XXS: 1, XS: 1).
              </p>
            </div>
          ) : (
            a4Pages.map((pageTickets, pageIdx) => (
              <div
                key={pageIdx}
                className="print-page-a4"
                style={{
                  background: '#ffffff',
                  boxShadow: '0 4px 18px rgba(0,0,0,0.3)',
                  borderRadius: '4px',
                  padding: '8px 10px',
                  marginBottom: '30px',
                  boxSizing: 'border-box',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  gap: '8px',
                  minHeight: '1060px',
                  height: '1060px'
                }}
              >
                {/* On-screen page label */}
                <div className="no-print" style={{ fontSize: '11.5px', color: '#666', borderBottom: '1px dashed #ccc', paddingBottom: '4px', display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
                  <span>A4 Varaq: #{pageIdx + 1} / {a4Pages.length}</span>
                  <span>Pattalar: {pageTickets.map(t => `#${t.pattaNumber} (${t.size})`).join(', ')}</span>
                </div>
                {pageTickets.map((t) => {
                  const opCount = t.operations.length;
                  const dyn = opCount <= 12
                    ? {
                        tableFontSize: '12pt',
                        titleFontSize: '14.5pt',
                        headerHeight: '23px',
                        cellPadding: '1.2px 4px',
                        opFontSize: '12.5pt',
                        idxFontSize: '11.5pt',
                        lineHeight: '1.14',
                        verticalPattaFontSize: '24pt',
                        verticalPachkaFontSize: '15pt',
                        verticalSizesFontSize: '11pt',
                        verticalPattaLetterSpacing: '1.5px'
                      }
                    : opCount <= 15
                    ? {
                        tableFontSize: '11.5pt',
                        titleFontSize: '13.5pt',
                        headerHeight: '20px',
                        cellPadding: '0.8px 4px',
                        opFontSize: '11.5pt',
                        idxFontSize: '11pt',
                        lineHeight: '1.10',
                        verticalPattaFontSize: '21pt',
                        verticalPachkaFontSize: '13.5pt',
                        verticalSizesFontSize: '10.5pt',
                        verticalPattaLetterSpacing: '1.2px'
                      }
                    : opCount <= 20
                    ? {
                        tableFontSize: '10.5pt',
                        titleFontSize: '12.5pt',
                        headerHeight: '17px',
                        cellPadding: '0.5px 3.5px',
                        opFontSize: '11.5pt',
                        idxFontSize: '10.5pt',
                        lineHeight: '1.08',
                        verticalPattaFontSize: '18.5pt',
                        verticalPachkaFontSize: '12.5pt',
                        verticalSizesFontSize: '9.5pt',
                        verticalPattaLetterSpacing: '0.8px'
                      }
                    : opCount <= 23
                    ? {
                        tableFontSize: '10pt',
                        titleFontSize: '11.5pt',
                        headerHeight: '15.5px',
                        cellPadding: '0.4px 3px',
                        opFontSize: '10.8pt',
                        idxFontSize: '9.5pt',
                        lineHeight: '1.05',
                        verticalPattaFontSize: '16.5pt',
                        verticalPachkaFontSize: '11pt',
                        verticalSizesFontSize: '9pt',
                        verticalPattaLetterSpacing: '0.5px'
                      }
                    : {
                        tableFontSize: '9.5pt',
                        titleFontSize: '11pt',
                        headerHeight: '14.5px',
                        cellPadding: '0.2px 2.5px',
                        opFontSize: '10pt',
                        idxFontSize: '9pt',
                        lineHeight: '1.03',
                        verticalPattaFontSize: '14.5pt',
                        verticalPachkaFontSize: '10pt',
                        verticalSizesFontSize: '8.5pt',
                        verticalPattaLetterSpacing: '0.2px'
                      };

                  return (
                    <div
                      key={t.ticketIndex}
                      className="print-ticket-box"
                      style={{
                        flex: '1 1 50%',
                        height: '515px',
                        maxHeight: '515px',
                        backgroundColor: '#ffffff',
                        border: 'none',
                        padding: '0',
                        boxSizing: 'border-box',
                        display: 'flex',
                        flexDirection: 'column',
                        overflow: 'hidden'
                      }}
                    >
                      <table
                        className="print-ticket-table"
                        style={{
                          width: '100%',
                          height: '100%',
                          flex: 1,
                          borderCollapse: 'collapse',
                          fontFamily: "'Times New Roman', Times, serif",
                          fontSize: dyn.tableFontSize,
                          fontWeight: 'bold',
                          color: '#000000',
                          lineHeight: dyn.lineHeight
                        }}
                      >
                        <colgroup>
                          <col style={{ width: '36px' }} />
                          <col style={{ width: '315px' }} />
                          <col style={{ width: '72px' }} />
                          <col style={{ width: '175px' }} />
                          <col style={{ width: '140px' }} />
                        </colgroup>
                        <tbody>
                          {/* ROW 1: Model Title */}
                          <tr style={{ height: dyn.headerHeight }}>
                            <td style={{ border: borderStyle, textAlign: 'center', fontWeight: 'bold' }}></td>
                            <td
                              colSpan={4}
                              style={{
                                border: borderStyle,
                                textAlign: 'center',
                                fontWeight: 'bold',
                                fontSize: dyn.titleFontSize,
                                padding: dyn.cellPadding,
                                letterSpacing: '0.02em'
                              }}
                            >
                              Модел- {t.modelTitle}
                            </td>
                          </tr>

                          {/* ROW 2: Konveyer & Date */}
                          <tr style={{ height: dyn.headerHeight }}>
                            <td style={{ border: borderStyle }}></td>
                            <td style={{ border: borderStyle, fontWeight: 'bold', textAlign: 'right', paddingRight: '12px', fontSize: dyn.tableFontSize, padding: dyn.cellPadding }}>
                              Конвейер
                            </td>
                            <td style={{ border: borderStyle, textAlign: 'center', fontWeight: 'bold', fontSize: dyn.tableFontSize, padding: dyn.cellPadding }}>
                              {/* Bo'sh turadi, chevarlar qo'lda yozadi */}
                            </td>
                            <td colSpan={2} style={{ border: borderStyle, textAlign: 'center', fontWeight: 'bold', fontSize: dyn.tableFontSize, padding: dyn.cellPadding }}>
                              Сана: {t.date}
                            </td>
                          </tr>

                          {/* ROW 3: Partiya */}
                          <tr style={{ height: dyn.headerHeight }}>
                            <td style={{ border: borderStyle }}></td>
                            <td style={{ border: borderStyle, fontWeight: 'bold', textAlign: 'right', paddingRight: '12px', fontSize: dyn.tableFontSize, padding: dyn.cellPadding }}>
                              Партия
                            </td>
                            <td style={{ border: borderStyle, textAlign: 'center', fontWeight: 'bold', fontSize: dyn.tableFontSize, padding: dyn.cellPadding }}>
                              {t.party}
                            </td>
                            <td colSpan={2} style={{ border: borderStyle, textAlign: 'center', fontWeight: 'bold', fontSize: dyn.tableFontSize, padding: dyn.cellPadding }}>
                            </td>
                          </tr>

                          {/* ROW 3: Patta, Rang, Razmer */}
                          <tr style={{ height: dyn.headerHeight }}>
                            <td style={{ border: borderStyle }}></td>
                            <td style={{ border: borderStyle, fontWeight: 'bold', textAlign: 'right', paddingRight: '12px', fontSize: dyn.tableFontSize, padding: dyn.cellPadding }}>
                              Патта
                            </td>
                            <td style={{ border: borderStyle, textAlign: 'center', fontWeight: 'bold', fontSize: dyn.tableFontSize, padding: dyn.cellPadding }}>
                              {t.pattaNumber}
                            </td>
                            <td style={{ border: borderStyle, textAlign: 'center', fontWeight: 'bold', fontSize: dyn.tableFontSize, padding: dyn.cellPadding }}>
                              Ранг
                            </td>
                            <td style={{ border: borderStyle, textAlign: 'center', fontWeight: 'bold', fontSize: dyn.tableFontSize, padding: dyn.cellPadding }}>
                              Размер
                            </td>
                          </tr>

                          {/* ROW 4: Ish soni, Rang val, Razmer val */}
                          <tr style={{ height: dyn.headerHeight }}>
                            <td style={{ border: borderStyle }}></td>
                            <td style={{ border: borderStyle, fontWeight: 'bold', textAlign: 'right', paddingRight: '12px', fontSize: dyn.tableFontSize, padding: dyn.cellPadding }}>
                              Иш сони
                            </td>
                            <td style={{ border: borderStyle, textAlign: 'center', fontWeight: 'bold', fontSize: dyn.tableFontSize, padding: dyn.cellPadding }}>
                              {t.ishSoni}
                            </td>
                            <td style={{ border: borderStyle, textAlign: 'center', fontWeight: 'bold', fontSize: dyn.tableFontSize, padding: dyn.cellPadding }}>
                              {t.color}
                            </td>
                            <td style={{ border: borderStyle, textAlign: 'center', fontWeight: 'bold', fontSize: dyn.tableFontSize, padding: dyn.cellPadding }}>
                              {t.size}
                            </td>
                          </tr>

                          {/* ROW 5: Header (№, Operatsiya nomi, Nomer, Ism familiya, Brak ish) */}
                          <tr style={{ height: dyn.headerHeight, fontWeight: 'bold', backgroundColor: '#e2e8f0' }}>
                            <td style={{ border: borderStyle, textAlign: 'center', fontSize: dyn.tableFontSize, padding: dyn.cellPadding }}>№</td>
                            <td style={{ border: borderStyle, textAlign: 'center', fontSize: dyn.tableFontSize, padding: dyn.cellPadding }}>Операция номи</td>
                            <td style={{ border: borderStyle, textAlign: 'center', fontSize: dyn.tableFontSize, padding: dyn.cellPadding }}>Номер</td>
                            <td style={{ border: borderStyle, textAlign: 'center', fontSize: dyn.tableFontSize, padding: dyn.cellPadding }}>Исм familiya</td>
                            <td style={{ border: borderStyle, textAlign: 'center', fontSize: dyn.tableFontSize, padding: dyn.cellPadding }}>Брак ish</td>
                          </tr>

                          {/* ROW 6+: Dynamic Operations with Large Vertical Patta № in Column E */}
                          {t.operations.map((op, opIdx) => (
                            <tr key={opIdx} style={{ height: 'auto' }}>
                              <td style={{ border: borderStyle, textAlign: 'center', fontWeight: 'bold', fontSize: dyn.idxFontSize, padding: dyn.cellPadding }}>
                                {opIdx + 1}
                              </td>
                              <td
                                style={{
                                  border: borderStyle,
                                  padding: dyn.cellPadding,
                                  paddingLeft: '6px',
                                  fontSize: dyn.opFontSize,
                                  fontWeight: 'bold',
                                  whiteSpace: 'nowrap',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis'
                                }}
                              >
                                {op.name}
                              </td>
                              <td style={{ border: borderStyle }}></td>
                              <td style={{ border: borderStyle }}></td>
                              {opIdx === 0 && (
                                <td
                                  rowSpan={t.operations.length}
                                  style={{
                                    border: borderStyle,
                                    textAlign: 'center',
                                    verticalAlign: 'middle',
                                    fontWeight: 'bold',
                                    color: '#000000',
                                    padding: '4px',
                                    overflow: 'hidden'
                                  }}
                                >
                                  <div style={{
                                    height: '100%',
                                    width: '100%',
                                    display: 'grid',
                                    gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr)',
                                    alignItems: 'center',
                                    justifyItems: 'stretch',
                                    gap: '3px',
                                    overflow: 'hidden'
                                  }}>
                                    {t.sizesSummary ? (
                                      <div style={{
                                        gridColumn: '1',
                                        width: '100%',
                                        height: '100%',
                                        minWidth: 0,
                                        minHeight: 0,
                                        display: 'grid',
                                        gridTemplateColumns: `repeat(${Math.min(4, t.sizesSummary.length)}, minmax(0, 1fr))`,
                                        gridTemplateRows: `repeat(${Math.ceil(t.sizesSummary.length / Math.min(4, t.sizesSummary.length))}, minmax(0, 1fr))`,
                                        gridAutoFlow: 'column',
                                        alignItems: 'stretch',
                                        justifyItems: 'stretch',
                                        gap: '1px',
                                        overflow: 'hidden'
                                      }}>
                                        {t.sizesSummary.map((sizeLine, sizeIndex) => (
                                          <div key={`${sizeLine}-${sizeIndex}`} style={{
                                            writingMode: 'vertical-lr',
                                            textOrientation: 'sideways' as any,
                                            WebkitTextOrientation: 'sideways' as any,
                                            fontSize: '8pt',
                                            fontWeight: 'bold',
                                            lineHeight: 1.05,
                                            textAlign: 'center',
                                            whiteSpace: 'nowrap',
                                            overflow: 'hidden',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center'
                                          }}>
                                            {sizeLine}
                                          </div>
                                        ))}
                                      </div>
                                    ) : null}
                                    <div style={{
                                      gridColumn: '2',
                                      height: '100%',
                                      minWidth: 0,
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      textAlign: 'center',
                                      writingMode: 'vertical-lr',
                                      textOrientation: 'sideways' as any,
                                      WebkitTextOrientation: 'sideways' as any,
                                      fontSize: dyn.verticalPattaFontSize,
                                      letterSpacing: dyn.verticalPattaLetterSpacing,
                                      fontWeight: 'bold',
                                      whiteSpace: 'nowrap'
                                    }}>
                                      Партия № {t.party}
                                    </div>
                                    <div style={{
                                      gridColumn: '3',
                                      height: '100%',
                                      minWidth: 0,
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      textAlign: 'center',
                                      writingMode: 'vertical-lr',
                                      textOrientation: 'sideways' as any,
                                      WebkitTextOrientation: 'sideways' as any,
                                      fontSize: dyn.verticalPachkaFontSize,
                                      fontWeight: 'bold',
                                      letterSpacing: '0.5px',
                                      whiteSpace: 'nowrap'
                                    }}>
                                      {t.pachkaCount} та пачка
                                    </div>
                                  </div>
                                </td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>

    </div>
  );
};
