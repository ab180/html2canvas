import {Bounds, parseBounds, parseDocumentSize} from './css/layout/bounds';
import {color, Color, COLORS, isTransparent} from './css/types/color';
import {Parser} from './css/syntax/parser';
import {CloneOptions, DocumentCloner} from './dom/document-cloner';
import {isBodyElement, isHTMLElement, parseTree} from './dom/node-parser';
import {Logger} from './core/logger';
import {CacheStorage, ResourceOptions} from './core/cache-storage';
import {CanvasRenderer, RenderOptions} from './render/canvas/canvas-renderer';
import {ForeignObjectRenderer} from './render/canvas/foreignobject-renderer';

export type Options = CloneOptions &
    RenderOptions &
    ResourceOptions & {
        backgroundColor: string | null;
        foreignObjectRendering: boolean;
        logging: boolean;
        removeContainer?: boolean;
        scrollPositions?: {
            [className: string]: {
                x: number;
                y: number;
            };
        };
        fullScreen: boolean;
    };

const parseColor = (value: string): Color => color.parse(Parser.create(value).parseComponentValue());

const html2canvas = (element: HTMLElement, options: Partial<Options> = {}): Promise<HTMLCanvasElement> => {
    return renderElement(element, options);
};

export default html2canvas;

if (typeof window !== "undefined") {
    CacheStorage.setContext(window);
}

const renderElement = async (element: HTMLElement, opts: Partial<Options>): Promise<HTMLCanvasElement> => {
    const ownerDocument = element.ownerDocument;

    if (!ownerDocument) {
        throw new Error(`Element is not attached to a Document`);
    }

    const defaultView = ownerDocument.defaultView;

    if (!defaultView) {
        throw new Error(`Document is not attached to a Window`);
    }

    const instanceName = (Math.round(Math.random() * 1000) + Date.now()).toString(16);

    const {width, height, left, top} =
        isBodyElement(element) || isHTMLElement(element) ? parseDocumentSize(ownerDocument) : parseBounds(element);

    const defaultResourceOptions = {
        allowTaint: false,
        imageTimeout: 15000,
        proxy: undefined,
        useCORS: false
    };

    const resourceOptions: ResourceOptions = {...defaultResourceOptions, ...opts};

    const defaultOptions = {
        backgroundColor: '#ffffff',
        cache: opts.cache ? opts.cache : CacheStorage.create(instanceName, resourceOptions),
        logging: true,
        removeContainer: true,
        foreignObjectRendering: false,
        scale: defaultView.devicePixelRatio || 1,
        windowWidth: defaultView.innerWidth,
        windowHeight: defaultView.innerHeight,
        scrollX: defaultView.pageXOffset,
        scrollY: defaultView.pageYOffset,
        scrollPositions: {},
        fullScreen: false,
        x: left,
        y: top,
        width: Math.ceil(width),
        height: Math.ceil(height),
        id: instanceName
    };

    const options: Options = {...defaultOptions, ...resourceOptions, ...opts};

    const windowBounds = new Bounds(options.scrollX, options.scrollY, options.windowWidth, options.windowHeight);

    Logger.create({id: instanceName, enabled: options.logging});
    Logger.getInstance(instanceName).debug(`Starting document clone`);
    const documentCloner = new DocumentCloner(element, {
        id: instanceName,
        onclone: options.onclone,
        ignoreElements: options.ignoreElements,
        inlineImages: options.foreignObjectRendering,
        copyStyles: options.foreignObjectRendering
    });
    const clonedElement = documentCloner.clonedReferenceElement;
    if (!clonedElement) {
        return Promise.reject(`Unable to find element in cloned iframe`);
    }

    const container = await documentCloner.toIFrame(ownerDocument, windowBounds);

    // http://www.w3.org/TR/css3-background/#special-backgrounds
    const documentBackgroundColor = ownerDocument.documentElement
        ? parseColor(getComputedStyle(ownerDocument.documentElement).backgroundColor as string)
        : COLORS.TRANSPARENT;
    const bodyBackgroundColor = ownerDocument.body
        ? parseColor(getComputedStyle(ownerDocument.body).backgroundColor as string)
        : COLORS.TRANSPARENT;

    const bgColor = opts.backgroundColor;
    const defaultBackgroundColor =
        typeof bgColor === 'string' ? parseColor(bgColor) : bgColor === null ? COLORS.TRANSPARENT : 0xffffffff;

    const backgroundColor =
        element === ownerDocument.documentElement
            ? isTransparent(documentBackgroundColor)
                ? isTransparent(bodyBackgroundColor)
                    ? defaultBackgroundColor
                    : bodyBackgroundColor
                : documentBackgroundColor
            : defaultBackgroundColor;

    const renderOptions = {
        id: instanceName,
        cache: options.cache,
        canvas: options.canvas,
        backgroundColor,
        scale: options.scale,
        x: options.x,
        y: options.y,
        scrollX: options.scrollX,
        scrollY: options.scrollY,
        width: options.width,
        height: options.height,
        windowWidth: options.windowWidth,
        windowHeight: options.windowHeight
    };

    //// AB180 Custom
    if (options.scrollPositions) {
        Object.keys(options.scrollPositions).forEach((className) => {
            const { x, y } = options.scrollPositions![className];
            const target = clonedElement.querySelector(className);

            if (target) {
                target.scrollLeft = x;
                target.scrollTop = y;
            }
        });
    }

    const tickContainer = clonedElement.querySelectorAll('.recharts-surface');
    const tickElements = clonedElement.querySelectorAll('.recharts-cartesian-grid-horizontal');
    const extractTickElements: (HTMLElement | null)[] = [];
    const standardWidth = renderOptions.windowWidth;

    if (options.fullScreen) {
        tickContainer.forEach(item => {
            const itemAttr = item.getAttribute('viewBox')!.split(' ');

            const result = itemAttr.map((attr, index) => {
                if (index === 2) {
                    return `${standardWidth}`;
                }
                return attr;
            });
            item.setAttribute('width', `${standardWidth}`);
            item.setAttribute('viewBox', result.join(' '));
        });

        tickElements.forEach(item => {
            extractTickElements.push(item.parentElement);
            const tick = item.querySelectorAll('line');
            tick.forEach(tickItem => {
                tickItem.setAttribute('x2', `${standardWidth}`);
                tickItem.setAttribute('width', `${standardWidth}`);
            });
        });
    }

    const editFontElement = clonedElement.querySelectorAll('tspan');
    if (editFontElement) {
        editFontElement.forEach(item => {
            item.setAttribute(
                'font-family',
                window.getComputedStyle(item, null).getPropertyValue('font-family')
            );
        });
    }


    // Library
    let canvas;

    if (options.foreignObjectRendering) {
        Logger.getInstance(instanceName).debug(`Document cloned, using foreign object rendering`);
        const renderer = new ForeignObjectRenderer(renderOptions);
        canvas = await renderer.render(clonedElement);
    } else {
        Logger.getInstance(instanceName).debug(`Document cloned, using computed rendering`);

        CacheStorage.attachInstance(options.cache);
        Logger.getInstance(instanceName).debug(`Starting DOM parsing`);
        const root = parseTree(clonedElement);
        CacheStorage.detachInstance();

        if (backgroundColor === root.styles.backgroundColor) {
            root.styles.backgroundColor = COLORS.TRANSPARENT;
        }

        Logger.getInstance(instanceName).debug(`Starting renderer`);

        const renderer = new CanvasRenderer(renderOptions);
        canvas = await renderer.render(root);
    }

    if (options.removeContainer === true) {
        if (!DocumentCloner.destroy(container)) {
            Logger.getInstance(instanceName).error(`Cannot detach cloned iframe as it is not in the DOM anymore`);
        }
    }

    Logger.getInstance(instanceName).debug(`Finished rendering`);
    Logger.destroy(instanceName);
    CacheStorage.destroy(instanceName);
    return canvas;
};
